import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBankCatalog, chooseQuestionIds, calculateSetResult, categoryStatistics } from '../src/client/study-engine.js';

const definition={id:'bank-one',title:'Bank One',questions:[
  {id:'q1',chapterTitle:'Mood',question:'One?',choices:['A1','B1'],choiceLetters:['A','B'],correctLetter:'A',explanation:'x'},
  {id:'q2',chapterTitle:'Mood',question:'Two?',choices:['A2','B2'],choiceLetters:['A','B'],correctLetter:'B',explanation:'y'},
  {id:'q3',chapterTitle:'Psychosis',question:'Three?',choices:['A3','B3'],choiceLetters:['A','B'],correctLetter:'A',explanation:'z'}
]};

test('normalizes a valid bank and preserves bank-bound question ids',()=>{const [bank]=buildBankCatalog([definition]);assert.equal(bank.id,'bank-one');assert.equal(bank.questions.length,3);assert.equal(bank.byId.get('q2').correctLetter,'B')});

test('rejects duplicate bank and question ids',()=>{assert.throws(()=>buildBankCatalog([definition,definition]),/Duplicate bank id/);assert.throws(()=>buildBankCatalog([{...definition,questions:[definition.questions[0],definition.questions[0]]}]),/Duplicate question id/)});

test('rejects malformed questions before the app starts',()=>{assert.throws(()=>buildBankCatalog([{id:'bad',questions:[{id:'x',question:'Broken',choices:['Only one'],correctLetter:'A'}]}]),/Invalid question/)});

test('filters new incorrect and flagged pools without crossing bank state',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:false}],['q2',{timesUsed:1,isCorrect:true,isFlagged:true}]]);assert.deepEqual(chooseQuestionIds(bank,progress,'new',10,()=>0),['q3']);assert.deepEqual(chooseQuestionIds(bank,progress,'incorrect',10,()=>0),['q1']);assert.deepEqual(chooseQuestionIds(bank,progress,'flagged',10,()=>0),['q2'])});

test('calculates answered omitted correct and incorrect totals',()=>{const [bank]=buildBankCatalog([definition]);const answers=new Map([['q1',{selectedAnswer:'A'}],['q2',{selectedAnswer:'A'}]]);assert.deepEqual(calculateSetResult(['q1','q2','q3'],answers,bank),{total:3,answered:2,omitted:1,correct:1,incorrect:1})});

test('builds category accuracy and timing statistics',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:true,totalTimeMs:1000}],['q2',{timesUsed:1,isCorrect:false,totalTimeMs:3000}]]);const mood=categoryStatistics(bank,progress).find(row=>row.title==='Mood');assert.equal(mood.answered,2);assert.equal(mood.correct,1);assert.equal(mood.accuracy,.5);assert.equal(mood.averageTimeMs,2000)});
