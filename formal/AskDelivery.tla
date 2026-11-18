----------------------------- MODULE AskDelivery -----------------------------
EXTENDS Naturals

\* A visible ID can be reused on a sibling branch. A question's birth revision
\* stands for its original history entry, while a dialog also captures the
\* revision at which it opened. Distinct retries always receive fresh keys.
\* A key stands for the UUID in Pi's custom-message details, not message text.
CONSTANTS QuestionIds, AttemptKeys, UnrelatedKey, MaxRevision
ASSUME MaxRevision \in Nat /\ UnrelatedKey \notin AttemptKeys

VARIABLES revision, usedIds, pending, issued, attempts, dialogs, receipt
vars == <<revision, usedIds, pending, issued, attempts, dialogs, receipt>>

Kinds == {"answer", "dismiss"}
Questions(ids, rev) == ids \X (0..rev)
Deliveries(questions) == AttemptKeys \X questions \X Kinds
AttemptIds(records) == {a[1] : a \in records}

Init ==
    /\ revision = 0
    /\ usedIds = {}
    /\ pending = {}
    /\ issued = {}
    /\ attempts = {}
    /\ dialogs = {}
    /\ receipt = UnrelatedKey

Enqueue(id) ==
    /\ revision \in Nat
    /\ id \notin usedIds
    /\ usedIds' = usedIds \cup {id}
    /\ pending' = pending \cup {<<id, revision>>}
    /\ UNCHANGED <<revision, issued, attempts, dialogs, receipt>>

OpenAnswer(q) ==
    /\ q \in pending
    /\ dialogs' = dialogs \cup {<<q, revision>>}
    /\ UNCHANGED <<revision, usedIds, pending, issued, attempts, receipt>>

CancelAnswer(dialog) ==
    /\ dialog \in dialogs
    /\ dialogs' = dialogs \ {dialog}
    /\ UNCHANGED <<revision, usedIds, pending, issued, attempts, receipt>>

RecordAttempt(q, key, kind) ==
    /\ q \in pending
    /\ key \notin AttemptIds(issued)
    /\ attempts' = attempts \cup {<<key, q, kind>>}
    /\ issued' = issued \cup {<<key, q, kind>>}
    /\ UNCHANGED <<revision, usedIds, pending, receipt>>

SubmitAnswer(q, key) ==
    /\ <<q, revision>> \in dialogs
    /\ dialogs' = dialogs \ {<<q, revision>>}
    /\ RecordAttempt(q, key, "answer")

Dismiss(q, key) ==
    /\ RecordAttempt(q, key, "dismiss")
    /\ UNCHANGED dialogs

\* A receipt may arrive after retries or restoration, including a receipt
\* for another branch, an unrelated input, or a duplicate of one already received.
Matches(key) == {a[2] : a \in {a \in attempts : a[1] = key}}
Receive(key) ==
    /\ receipt' = key
    /\ pending' = pending \ Matches(key)
    /\ attempts' = {a \in attempts : a[2] \notin Matches(key)}
    /\ UNCHANGED <<revision, usedIds, issued, dialogs>>

\* Restore takes a snapshot of a branch after replay. Attempts in that snapshot
\* must refer to their original questions and have no matching receipt yet.
\* The choice abstracts history order, tree shape, and the legacy text reader.
Restore ==
    /\ revision \in Nat
    /\ revision < MaxRevision
    /\ revision' = revision + 1
    /\ \E ids \in SUBSET QuestionIds :
        /\ usedIds' = ids
        /\ \E restored \in SUBSET Questions(ids, revision + 1) :
            /\ \A q, r \in restored : q[1] = r[1] => q = r
            /\ pending' = restored
            /\ attempts' \in SUBSET (issued \cap Deliveries(restored))
    /\ UNCHANGED <<issued, dialogs, receipt>>

Receipts == AttemptKeys \cup {UnrelatedKey}

Next ==
    \/ \E id \in QuestionIds : Enqueue(id)
    \/ \E q \in pending : OpenAnswer(q)
    \/ \E dialog \in dialogs : CancelAnswer(dialog)
    \/ \E q \in pending, key \in AttemptKeys : SubmitAnswer(q, key) \/ Dismiss(q, key)
    \/ \E key \in Receipts : Receive(key)
    \/ Restore

Spec == Init /\ [][Next]_vars

UniqueKeys ==
    \A a, b \in issued : a[1] = b[1] => a = b

Safety ==
    /\ pending \subseteq Questions(usedIds, revision)
    /\ attempts \subseteq (issued \cap Deliveries(pending))
    /\ UniqueKeys

RemovalHasReceipt ==
    revision' = revision /\ pending \ pending' # {} =>
        /\ receipt' \in Receipts
        /\ Receive(receipt')
        /\ \A q \in pending \ pending' :
              \E a \in attempts : a[1] = receipt' /\ a[2] = q

NoUnacknowledgedRemoval == [][RemovalHasReceipt]_vars

ReceiptIsolated ==
    revision' = revision =>
        \A q \in pending \ pending', a \in issued :
            a[1] = receipt' => a[2] = q

NoWrongQuestionRemoved == [][ReceiptIsolated]_vars
=============================================================================
