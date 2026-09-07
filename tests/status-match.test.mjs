// Verify status intersections without changing legacy union or other filters.
import test from 'node:test';
import assert from 'node:assert/strict';
import {eligibleQuestionIds, normalizeSpecialTestCriteria} from '../src/client/study-engine.js';
const bank = {questions: ['both','wrong','flagged','new'].map(id => ({id,subjectTitle:'S',chapterTitle:'T'}))};
const progress = new Map([
  ['both',{timesUsed:1,isCorrect:false,isFlagged:true}],
  ['wrong',{timesUsed:1,isCorrect:false}],
  ['flagged',{timesUsed:1,isCorrect:true,isFlagged:true}],
]);
test('AND requires all statuses; OR and legacy defaults accept any', () => {
  const pools = ['incorrect','flagged'];
  assert.deepEqual(eligibleQuestionIds(bank,progress,pools), ['both','wrong','flagged']);
  assert.deepEqual(eligibleQuestionIds(bank,progress,pools,null,{statusMatch:'and'}), ['both']);
  assert.deepEqual(eligibleQuestionIds(bank,progress,['new','used'],null,{statusMatch:'and'}), []);
  assert.deepEqual(eligibleQuestionIds(bank,progress,[],null,{statusMatch:'and'}), []);
  assert.deepEqual(eligibleQuestionIds(bank,progress,['all'],null,{statusMatch:'and'}), ['both','wrong','flagged','new']);
  assert.deepEqual(eligibleQuestionIds(bank,progress,pools,{subjects:['other']},{statusMatch:'and'}), []);
  assert.deepEqual(eligibleQuestionIds(bank,progress,pools,null,{statusMatch:'and',rangeStart:2,rangeEnd:4}), []);
});
test('AND survives criteria normalization and flagged override cannot bypass it', () => {
  const criteria = normalizeSpecialTestCriteria({statusMatch:'and',includeFlagged:true});
  assert.equal(normalizeSpecialTestCriteria(JSON.parse(JSON.stringify(criteria))).statusMatch,'and');
  assert.deepEqual(eligibleQuestionIds(bank,progress,['incorrect'],null,criteria), ['both']);
});
