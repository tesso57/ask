------------------------------ MODULE AskReplay ------------------------------
EXTENDS Naturals, Sequences

CONSTANTS QuestionIds, AttemptKeys, NoValue, MaxEntries

\* Normalized v2 entries. Questions carry identity as their visible ID on a
\* branch; retries have fresh UUIDs. Answers and dismissals use the same receipt
\* format. Other includes user text, unrelated entries and discarded messages.
\* Observation is after a successful append. The receipt's custom type and
\* UUID are the same at live receipt and in the persisted history.
\* Legacy matching and receipt rewriting are exercised in AskReplayBoundary.
Question(q) == <<"question", q, NoValue>>
Attempt(q, k) == <<"attempt", q, k>>
Receipt(k) == <<"receipt", NoValue, k>>
Other == <<"other", NoValue, NoValue>>
Entries ==
    {Question(q) : q \in QuestionIds}
    \cup {Attempt(q, k) : q \in QuestionIds, k \in AttemptKeys}
    \cup {Receipt(k) : k \in AttemptKeys}
    \cup {Other}

Empty == [pending |-> {}, attempts |-> {}]

\* The pending question table and the UUID-to-question table in index.ts.
\* Under key uniqueness the attempts relation is a partial function.
Step(s, e) ==
    CASE e[1] = "question" ->
        [s EXCEPT !.pending = @ \cup {e[2]}]
    [] e[1] = "attempt" /\ e[2] \in s.pending ->
        [s EXCEPT !.attempts = @ \cup {<<e[3], e[2]>>}]
    [] e[1] = "receipt" ->
        LET closed == {a[2] : a \in {a \in s.attempts : a[1] = e[3]}}
        IN [pending |-> s.pending \ closed,
            attempts |-> {a \in s.attempts : a[2] \notin closed}]
    [] OTHER -> s

Prefix(h, n) == SubSeq(h, 1, n)
Positions(h) == 1..Len(h)

ReplayStates(h) ==
    LET states[i \in 0..Len(h)] ==
        IF i = 0 THEN Empty ELSE Step(states[i - 1], h[i])
    IN states

Replay(h) == ReplayStates(h)[Len(h)]

\* Independent interpretation of a branch. A receipt closes a question only
\* when its matching delivery attempt is earlier on that same root-to-leaf path.
\* The branch well-formedness rule places the question before the attempt.
Seen(h) ==
    {q \in QuestionIds : \E i \in Positions(h) : h[i] = Question(q)}
Witnesses(h) ==
    {a \in AttemptKeys \X QuestionIds :
        \E i \in Positions(h) : h[i] = Attempt(a[2], a[1])}
Received(h) ==
    {q \in QuestionIds :
        \E i, j \in Positions(h), k \in AttemptKeys :
            i < j /\ h[i] = Attempt(q, k) /\ h[j] = Receipt(k)}
Expected(h) == Seen(h) \ Received(h)
ExpectedAttempts(h) == {a \in Witnesses(h) : a[2] \in Expected(h)}

ValidAppend(h, e) ==
    \/ \E q \in QuestionIds : e = Question(q) /\ q \notin Seen(h)
    \/ \E q \in Expected(h), k \in AttemptKeys :
        e = Attempt(q, k) /\ \A a \in Witnesses(h) : a[1] # k
    \/ \E k \in AttemptKeys : e = Receipt(k)
    \/ e = Other

WellFormed(h) ==
    /\ h \in Seq(Entries)
    /\ \A i \in Positions(h) : ValidAppend(Prefix(h, i - 1), h[i])

\* A session tree in append order. A parent is an older entry, or zero at
\* the root. Navigation reconstructs the destination state from its entries.
VARIABLES tree, leaf, visible
vars == <<tree, leaf, visible>>

Branch(t, i) ==
    LET branches[n \in 0..Len(t)] ==
        IF n = 0 THEN <<>>
        ELSE Append(branches[t[n].parent], t[n].entry)
    IN branches[i]

Init ==
    /\ tree = <<>>
    /\ leaf = 0
    /\ visible = Empty

Record(e) ==
    LET h == Branch(tree, leaf)
    IN /\ Len(tree) < MaxEntries
       /\ ValidAppend(h, e)
       /\ (e[1] = "question" => \A q \in Seen(h) : q < e[2])
       /\ (e[1] = "attempt" =>
               \A node \in {tree[i] : i \in Positions(tree)} :
                   node.entry[1] = "attempt" => node.entry[3] # e[3])
       /\ tree' = Append(tree, [parent |-> leaf, entry |-> e])
       /\ leaf' = Len(tree) + 1
       /\ visible' = Step(visible, e)

Navigate(i) ==
    /\ i # leaf
    /\ leaf' = i
    /\ visible' = Replay(Branch(tree, i))
    /\ UNCHANGED tree

Next ==
    \/ \E e \in Entries : Record(e)
    \/ \E i \in 0..Len(tree) : Navigate(i)

Spec == Init /\ [][Next]_vars

ReplayAgreement ==
    LET h == Branch(tree, leaf)
    IN /\ visible.pending = Expected(h)
       /\ visible.attempts = ExpectedAttempts(h)
       /\ visible = Replay(h)
=============================================================================
