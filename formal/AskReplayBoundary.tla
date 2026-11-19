-------------------------- MODULE AskReplayBoundary --------------------------
EXTENDS AskReplay, FiniteSets

CONSTANT Scenario
ASSUME Scenario \in {"legacyQuote", "rewrittenReceipt"}

\* Legacy message bodies are abstracted to text identities. Each legacy text
\* belongs to one question because the stored answer contains its question ID.
\* A user message carries its exact match (empty or singleton) and its substring
\* matches. A wrapper or quote has substring matches only.
LegacyAttempt(q, text) == <<"v1-attempt", q, text>>
UserText(exact, contains) == <<"user-text", exact, contains>>

MixedEmpty == [core |-> Empty, legacy |-> {}]

MixedStep(s, e) ==
    CASE e[1] = "v1-attempt" /\ e[2] \in s.core.pending ->
        [s EXCEPT !.legacy = @ \cup {<<e[3], e[2]>>}]
    [] e[1] = "user-text" ->
        LET exact == {a[2] : a \in {a \in s.legacy : a[1] \in e[2]}}
            wrapped == {a[2] : a \in {a \in s.legacy : a[1] \in e[3]}}
            candidates == IF exact = {} THEN wrapped ELSE exact
            closed == IF Cardinality(candidates) = 1 THEN candidates \cap s.core.pending ELSE {}
        IN [core |-> [pending |-> s.core.pending \ closed,
                      attempts |-> {a \in s.core.attempts : a[2] \notin closed}],
            legacy |-> {a \in s.legacy : a[2] \notin closed}]
    [] OTHER ->
        [core |-> Step(s.core, e),
         legacy |-> IF e[1] = "attempt" /\ e[2] \in s.core.pending
                    THEN {a \in s.legacy : a[2] # e[2]}
                    ELSE s.legacy]

MixedReplay(h) ==
    LET states[i \in 0..Len(h)] ==
        IF i = 0 THEN MixedEmpty ELSE MixedStep(states[i - 1], h[i])
    IN states[Len(h)].core

Subject == CHOOSE q \in QuestionIds : TRUE
Key == CHOOSE k \in AttemptKeys : TRUE
LegacyText == <<Subject, Key>>
InitialAttempt ==
    IF Scenario = "legacyQuote" THEN LegacyAttempt(Subject, LegacyText)
    ELSE Attempt(Subject, Key)

\* Both counterexamples start on one branch after its initial state is loaded.
BoundaryInit ==
    /\ tree = <<[parent |-> 0, entry |-> Question(Subject)],
                [parent |-> 1, entry |-> InitialAttempt]>>
    /\ leaf = 2
    /\ visible = MixedReplay(Branch(tree, leaf))

BoundaryNext ==
    /\ leaf = 2
    /\ leaf' = 3
    /\ IF Scenario = "legacyQuote"
          THEN /\ tree' = Append(tree, [parent |-> leaf,
                                        entry |-> UserText({}, {LegacyText})])
               /\ visible' = visible
          \* The handler sees the original UUID at message_start. A later
          \* message_end handler removes it before Pi appends the custom message.
          ELSE /\ tree' = Append(tree, [parent |-> leaf, entry |-> Other])
               /\ visible' = Step(visible, Receipt(Key))

BoundarySpec == BoundaryInit /\ [][BoundaryNext]_vars

BoundaryAgreement ==
    visible.pending = MixedReplay(Branch(tree, leaf)).pending
=============================================================================
