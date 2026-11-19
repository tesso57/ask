-------------------------- MODULE AskReplayProofs --------------------------
EXTENDS AskReplay, SequenceTheorems, NaturalsInduction, TLAPS

Oracle(h) == [pending |-> Expected(h), attempts |-> ExpectedAttempts(h)]

\* Only receipts with an earlier matching attempt can change the oracle.
NewReceipts(h, e) ==
    {q \in QuestionIds :
        \E k \in AttemptKeys : e = Receipt(k) /\ <<k, q>> \in Witnesses(h)}

AllAttemptsHaveQuestion(h) ==
    \A a \in Witnesses(h) : a[2] \in Seen(h)

LEMMA AppendOracleFacts ==
    ASSUME NEW h \in Seq(Entries), NEW e \in Entries
    PROVE /\ Seen(Append(h, e)) = Seen(h) \cup {q \in QuestionIds : e = Question(q)}
          /\ Witnesses(Append(h, e)) =
              Witnesses(h) \cup {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])}
          /\ Received(Append(h, e)) = Received(h) \cup NewReceipts(h, e)
<1>1. Len(h) \in Nat
    BY LenProperties
<1>2. Len(Append(h, e)) = Len(h) + 1
    /\ (\A i \in 1..Len(h) : Append(h, e)[i] = h[i])
    /\ Append(h, e)[Len(h)+1] = e
    BY AppendProperties
<1>3. 1..Len(Append(h, e)) = (1..Len(h)) \cup {Len(h)+1}
    BY <1>1, <1>2, SMT
<1>4. Seen(Append(h, e)) = Seen(h) \cup {q \in QuestionIds : e = Question(q)}
    BY <1>2, <1>3, SMT DEF Seen, Positions
<1>5. Witnesses(Append(h, e)) =
        Witnesses(h) \cup {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])}
    BY <1>2, <1>3, SMT DEF Witnesses, Positions
<1>6. Received(Append(h, e)) = Received(h) \cup NewReceipts(h, e)
    BY <1>1, <1>2, <1>3, SMT DEF Received, NewReceipts, Witnesses, Positions
<1> QED BY <1>4, <1>5, <1>6

LEMMA RecordedReceiptsHaveAttempt ==
    \A h : Received(h) \subseteq {a[2] : a \in Witnesses(h)}
<1>. SUFFICES ASSUME NEW h, NEW q \in Received(h)
               PROVE q \in {a[2] : a \in Witnesses(h)}
    BY SMT
<1>1. PICK i, j \in Positions(h), k \in AttemptKeys :
        i < j /\ h[i] = Attempt(q, k) /\ h[j] = Receipt(k)
    BY DEF Received
<1>2. <<k, q>> \in Witnesses(h)
    BY <1>1, SMT DEF Received, Witnesses
<1> QED BY <1>2, SMT

LEMMA OraclePreservation ==
    ASSUME NEW h \in Seq(Entries), NEW e \in Entries,
           ValidAppend(h, e), AllAttemptsHaveQuestion(h)
    PROVE /\ Step(Oracle(h), e) = Oracle(Append(h, e))
          /\ AllAttemptsHaveQuestion(Append(h, e))
<1>1. Received(h) \subseteq Seen(h)
    BY RecordedReceiptsHaveAttempt, SMT DEF AllAttemptsHaveQuestion
<1>2. /\ Seen(Append(h,e)) = Seen(h) \cup {q \in QuestionIds : e = Question(q)}
      /\ Witnesses(Append(h,e)) =
          Witnesses(h) \cup {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])}
      /\ Received(Append(h,e)) = Received(h) \cup NewReceipts(h, e)
    BY AppendOracleFacts
<1>3. Witnesses(h) \subseteq AttemptKeys \X QuestionIds
    BY SMT DEF Witnesses
<1>4. e[1] = "question" => e[2] \in QuestionIds /\ e[2] \notin Seen(h) /\ e = Question(e[2])
    BY SMT DEF ValidAppend, Question, Attempt, Receipt, Other
<1>5. e[1] = "attempt" => e[2] \in Expected(h) /\ e[3] \in AttemptKeys /\ e = Attempt(e[2],e[3])
    BY SMT DEF ValidAppend, Question, Attempt, Receipt, Other
<1>6. e[1] = "receipt" => e[3] \in AttemptKeys /\ e = Receipt(e[3])
    BY SMT DEF ValidAppend, Question, Attempt, Receipt, Other
<1>7. CASE e[1] = "question"
    <2>1. {q \in QuestionIds : e = Question(q)} = {e[2]}
        BY <1>4, <1>7, SMT, SetExtensionality DEF Question
    <2>2. {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])} = {} /\ NewReceipts(h, e) = {}
        BY <1>7, SMT, SetExtensionality DEF Attempt, Receipt, NewReceipts
    <2>3. /\ Seen(Append(h,e)) = Seen(h) \cup {e[2]}
          /\ Witnesses(Append(h,e)) = Witnesses(h)
          /\ Received(Append(h,e)) = Received(h)
        BY <1>2, <2>1, <2>2, Isa
    <2>4. Expected(Append(h,e)) = Expected(h) \cup {e[2]}
        BY <1>1, <1>4, <1>7, <2>3, SMT DEF Expected
    <2>5. ExpectedAttempts(Append(h,e)) = ExpectedAttempts(h)
        BY <2>3, <2>4, <1>4, <1>7, SMT DEF AllAttemptsHaveQuestion, ExpectedAttempts
    <2> QED BY <2>3, <2>4, <2>5, <1>7, SMT DEF Oracle, Step, AllAttemptsHaveQuestion
<1>8. CASE e[1] = "attempt"
    <2>1. {q \in QuestionIds : e = Question(q)} = {} /\ NewReceipts(h, e) = {}
        BY <1>8, SMT, SetExtensionality DEF Question, Receipt, NewReceipts
    <2>2. {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])} = {<<e[3], e[2]>>}
        BY <1>5, <1>8, SMT, SetExtensionality DEF Expected, Seen, Attempt
    <2>3. /\ Seen(Append(h,e)) = Seen(h)
          /\ Witnesses(Append(h,e)) = Witnesses(h) \cup {<<e[3], e[2]>>}
          /\ Received(Append(h,e)) = Received(h)
        BY <1>2, <2>1, <2>2, Isa
    <2>4. /\ Expected(Append(h,e)) = Expected(h)
          /\ ExpectedAttempts(Append(h,e)) = ExpectedAttempts(h) \cup {<<e[3], e[2]>>}
        BY <2>3, <1>5, <1>8, SMT DEF Expected, ExpectedAttempts
    <2> QED BY <2>3, <2>4, <1>5, <1>8, SMT DEF Oracle, Step, AllAttemptsHaveQuestion, Expected
<1>9. CASE e[1] = "receipt"
    <2>1. /\ {q \in QuestionIds : e = Question(q)} = {}
          /\ {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])} = {}
        BY <1>9, SMT, SetExtensionality DEF Question, Attempt
    <2>2. Seen(Append(h,e)) = Seen(h) /\ Witnesses(Append(h,e)) = Witnesses(h)
        BY <1>2, <2>1, Isa
    <2>3. Expected(Append(h,e)) = Expected(h) \ NewReceipts(h,e)
        BY <1>2, <2>2, SMT DEF Expected
    <2>4. {a[2] : a \in {a \in ExpectedAttempts(h) : a[1] = e[3]}} =
          NewReceipts(h,e) \cap Expected(h)
        BY <1>3, <1>6, <1>9, SMT DEF ExpectedAttempts, NewReceipts, Receipt
    <2>5. ExpectedAttempts(Append(h,e)) =
          {a \in ExpectedAttempts(h) : a[2] \notin NewReceipts(h,e) \cap Expected(h)}
        BY <2>2, <2>3, SMT DEF ExpectedAttempts
    <2>6. Expected(Append(h,e)) = Expected(h) \ (NewReceipts(h,e) \cap Expected(h))
        BY <2>3, SMT
    <2> QED BY <2>2, <2>4, <2>5, <2>6, <1>9, Isa DEF Oracle, Step, AllAttemptsHaveQuestion
<1>10. CASE e[1] \notin {"question", "attempt", "receipt"}
    <2>1. /\ {q \in QuestionIds : e = Question(q)} = {}
          /\ {a \in AttemptKeys \X QuestionIds : e = Attempt(a[2], a[1])} = {}
          /\ NewReceipts(h, e) = {}
        BY <1>10, SMT, SetExtensionality DEF NewReceipts, Question, Attempt, Receipt
    <2>2. /\ Seen(Append(h,e)) = Seen(h)
          /\ Witnesses(Append(h,e)) = Witnesses(h)
          /\ Received(Append(h,e)) = Received(h)
        BY <1>2, <2>1, Isa
    <2>3. Expected(Append(h,e)) = Expected(h)
        BY <2>2, SMT DEF Expected
    <2> QED BY <2>2, <2>3, <1>10, Isa DEF Step, Oracle, AllAttemptsHaveQuestion, ExpectedAttempts
<1> QED BY <1>7, <1>8, <1>9, <1>10, SMT

\* The oracle state at each prefix gives a witness for the recursive scan.
\* The recurrence then determines each scan value by induction on its index.
THEOREM ReplayMatchesOracle ==
    \A h \in Seq(Entries) : WellFormed(h) =>
        /\ Replay(h).pending = Expected(h)
        /\ Replay(h).attempts = ExpectedAttempts(h)
<1>. SUFFICES ASSUME NEW h \in Seq(Entries), WellFormed(h)
               PROVE /\ Replay(h).pending = Expected(h)
                     /\ Replay(h).attempts = ExpectedAttempts(h)
    OBVIOUS
<1>. DEFINE
    ScanRecurrence(f) ==
        f = [n \in 0..Len(h) |->
            IF n = 0 THEN Empty ELSE Step(f[n-1], h[n])]
    Reference == [n \in 0..Len(h) |-> Oracle(Prefix(h, n))]
    P(n) ==
        n \in 0..Len(h) =>
            /\ AllAttemptsHaveQuestion(Prefix(h, n))
            /\ Reference[n] =
                IF n = 0 THEN Empty ELSE Step(Reference[n-1], h[n])
<1>1. Len(h) \in Nat
    BY LenProperties
<1>2. P(0)
    <2>1. Prefix(h, 0) = <<>>
        BY SubSeqEmpty, SMT DEF Prefix
    <2>2. Len(<<>>) = 0
        BY SMT
    <2>3. Oracle(<<>>) = Empty /\ AllAttemptsHaveQuestion(<<>>)
        BY <2>2, SMT DEF Empty, Oracle, AllAttemptsHaveQuestion, Seen, Witnesses,
            Received, Expected, ExpectedAttempts, Positions
    <2> QED BY <2>1, <2>3, SMT DEF P, Reference
<1>3. ASSUME NEW n \in Nat, P(n)
      PROVE P(n+1)
    <2>. SUFFICES ASSUME n+1 \in 0..Len(h)
                   PROVE /\ AllAttemptsHaveQuestion(Prefix(h, n+1))
                         /\ Reference[n+1] = Step(Reference[n], h[n+1])
        BY SMT DEF P
    <2>1. n \in 0..Len(h) /\ n+1 \in Positions(h)
        BY <1>1, SMT DEF Positions
    <2>2. /\ Prefix(h, n) \in Seq(Entries)
          /\ h[n+1] \in Entries
          /\ Prefix(h, n+1) = Append(Prefix(h, n), h[n+1])
        <3>1. \A i \in 1..n : h[i] \in Entries
            BY <2>1, ElementOfSeq, SMT DEF Positions
        <3>2. Prefix(h, n) \in Seq(Entries) /\ h[n+1] \in Entries
            BY <3>1, <2>1, ElementOfSeq, SubSeqProperties, SMT DEF Prefix, Positions
        <3>3. Prefix(h, n+1) = Prefix(h, n) \o <<h[n+1]>>
            BY <2>1, SubSeqRecursive, SMT DEF Prefix, Positions
        <3> QED BY <3>2, <3>3, AppendIsConcat, SMT
    <2>3. ValidAppend(Prefix(h, n), h[n+1])
        BY <2>1, SMT DEF WellFormed
    <2>4. AllAttemptsHaveQuestion(Prefix(h, n))
        BY <2>1, P(n) DEF P
    <2>5. /\ AllAttemptsHaveQuestion(Prefix(h, n+1))
          /\ Oracle(Prefix(h, n+1)) = Step(Oracle(Prefix(h, n)), h[n+1])
        BY <2>2, <2>3, <2>4, OraclePreservation, SMT
    <2> QED BY <2>1, <2>5, SMT DEF Reference
<1>4. \A n \in Nat : P(n)
    BY <1>2, <1>3, NatInduction
<1>5. ScanRecurrence(Reference)
    BY <1>1, <1>4, SMT DEF ScanRecurrence, P, Reference
<1>6. \E f : ScanRecurrence(f)
    BY <1>5
<1>7. ReplayStates(h) = CHOOSE f : ScanRecurrence(f)
    BY DEF ReplayStates, ScanRecurrence
<1>8. ScanRecurrence(CHOOSE f : ScanRecurrence(f))
    BY <1>6, Zenon
<1>9. ScanRecurrence(ReplayStates(h))
    BY <1>7, <1>8, Zenon
<1>. DEFINE Q(n) == n \in 0..Len(h) => ReplayStates(h)[n] = Reference[n]
<1>10. Q(0)
    BY <1>5, <1>9, SMT DEF Q, ScanRecurrence
<1>11. ASSUME NEW n \in Nat, Q(n)
       PROVE Q(n+1)
    <2>. SUFFICES ASSUME n+1 \in 0..Len(h)
                   PROVE ReplayStates(h)[n+1] = Reference[n+1]
        BY DEF Q
    <2>1. n \in 0..Len(h)
        BY SMT
    <2>2. ReplayStates(h)[n] = Reference[n]
        BY <2>1, Q(n) DEF Q
    <2>3. ReplayStates(h)[n+1] = Step(ReplayStates(h)[n], h[n+1])
        BY <1>9, SMT DEF ScanRecurrence
    <2>4. Reference[n+1] = Step(Reference[n], h[n+1])
        BY <1>5, SMT DEF ScanRecurrence
    <2> QED BY <2>2, <2>3, <2>4
<1>12. \A n \in Nat : Q(n)
    BY <1>10, <1>11, NatInduction
<1>13. Prefix(h, Len(h)) = h
    BY <1>1, ElementOfSeq, SubSeqProperties, SeqEqual, SMT DEF Prefix
<1> QED BY <1>1, <1>12, <1>13, SMT DEF Q, Reference, Oracle, Replay
=============================================================================
