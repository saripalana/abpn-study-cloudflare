// Labels preserve creation-time criteria rather than infer them from results.
import test from 'node:test';
import assert from 'node:assert/strict';
import {practiceSetLabel} from '../src/client/practice-set-label.js';
import {persistenceRecordForSession} from '../src/client/multi-deck-app-session.js';
test('test label records AND, deck, range, subjects, source test and timing',()=>{
  const name=practiceSetLabel({mode:'test',timed:true,secondsPerQuestion:90,randomized:true,pool:['flagged','incorrect'],specialCriteria:{statusMatch:'and',rangeStart:10,rangeEnd:30},deckLabels:['Study Coach'],subjects:['Sleep'],sections:['Study Coach Test 5']});
  for(const expected of ['Flagged AND Wrong','Study Coach','Sleep','Test 5','10–30','90 sec/question','Randomized']) assert.ok(name.includes(expected));
  assert.equal(persistenceRecordForSession({id:'x',name,questionIds:['q']}).name,name);
});
test('default label uses OR and all subjects/sections',()=>{
  const name=practiceSetLabel({mode:'tutor',pool:['flagged','incorrect']});
  assert.match(name,/Flagged OR Wrong/);
  assert.match(name,/Subjects: All/);
  assert.match(name,/Source tests: All/);
});
