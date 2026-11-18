-------------------------- MODULE AskDeliveryProofs --------------------------
EXTENDS AskDelivery, TLAPS

THEOREM DeliverySafety == Spec => []Safety
<1>1. Init => Safety
    BY DEF Init, Safety, Questions, Deliveries, UniqueKeys
<1>2. Safety /\ [Next]_vars => Safety'
    <2>1. ASSUME Safety, NEW id \in QuestionIds, Enqueue(id) PROVE Safety'
        BY Safety, Enqueue(id), SMT DEF Enqueue, Safety, Questions, Deliveries, UniqueKeys
    <2>2. ASSUME Safety, NEW q, NEW dialog, OpenAnswer(q) \/ CancelAnswer(dialog)
          PROVE Safety'
        BY Safety, OpenAnswer(q) \/ CancelAnswer(dialog), SMT
            DEF OpenAnswer, CancelAnswer, Safety, Questions, Deliveries, UniqueKeys
    <2>3. ASSUME Safety, NEW q, NEW key \in AttemptKeys, SubmitAnswer(q, key) \/ Dismiss(q, key)
          PROVE Safety'
        BY Safety, SubmitAnswer(q, key) \/ Dismiss(q, key), SMT
            DEF SubmitAnswer, Dismiss, RecordAttempt, Safety, Deliveries, AttemptIds, UniqueKeys, Kinds
    <2>4. ASSUME Safety, NEW key \in Receipts, Receive(key) PROVE Safety'
        BY Safety, Receive(key), SMT DEF Receive, Safety, Questions, Deliveries, Matches, UniqueKeys
    <2>5. Safety /\ Restore => Safety'
        BY SMT DEF Restore, Safety, UniqueKeys
    <2>6. Safety /\ UNCHANGED vars => Safety'
        BY DEF vars, Safety, Questions, Deliveries, UniqueKeys
    <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6 DEF Next
<1> QED BY PTL, <1>1, <1>2 DEF Spec

THEOREM AcknowledgmentSafety == Spec => NoUnacknowledgedRemoval
<1>1. [Next]_vars => [RemovalHasReceipt]_vars
    <2>1. ASSUME NEW id \in QuestionIds, Enqueue(id) PROVE RemovalHasReceipt
        BY Enqueue(id), SMT DEF Enqueue, RemovalHasReceipt
    <2>2. ASSUME NEW q, NEW dialog, NEW key,
              OpenAnswer(q) \/ CancelAnswer(dialog) \/ SubmitAnswer(q, key) \/ Dismiss(q, key)
          PROVE RemovalHasReceipt
        BY OpenAnswer(q) \/ CancelAnswer(dialog) \/ SubmitAnswer(q, key) \/ Dismiss(q, key), SMT
            DEF OpenAnswer, CancelAnswer, SubmitAnswer, Dismiss, RecordAttempt, RemovalHasReceipt
    <2>3. ASSUME NEW key \in Receipts, Receive(key) PROVE RemovalHasReceipt
        BY Receive(key), SMT DEF Receive, RemovalHasReceipt, Matches
    <2>4. Restore => RemovalHasReceipt
        BY SMT DEF Restore, RemovalHasReceipt
    <2> QED BY <2>1, <2>2, <2>3, <2>4 DEF Next
<1> QED BY PTL, <1>1 DEF Spec, NoUnacknowledgedRemoval

THEOREM ReceiptSafety == Spec => NoWrongQuestionRemoved
<1>1. Safety /\ RemovalHasReceipt => ReceiptIsolated
    BY SMT DEF Safety, RemovalHasReceipt, ReceiptIsolated, UniqueKeys
<1>2. UNCHANGED vars => ReceiptIsolated
    BY DEF vars, ReceiptIsolated
<1> QED BY PTL, <1>1, <1>2, DeliverySafety, AcknowledgmentSafety
    DEF NoUnacknowledgedRemoval, NoWrongQuestionRemoved
=============================================================================
