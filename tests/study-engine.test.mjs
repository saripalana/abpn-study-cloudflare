import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBankCatalog,
  chooseQuestionIds,
  eligibleQuestionIds,
  normalizeQuestionPools,
  calculateSetResult,
  categoryStatistics,
  subjectStatistics
} from '../src/client/study-engine.js';

const definition={id:'bank-one',title:'Bank One',questions:[
  {id:'q1',chapterTitle:'Mood',question:'One?',choices:['A1','B1'],choiceLetters:['A','B'],correctLetter:'A',explanation:'x'},
  {id:'q2',chapterTitle:'Mood',question:'Two?',choices:['A2','B2'],choiceLetters:['A','B'],correctLetter:'B',explanation:'y'},
  {id:'q3',chapterTitle:'Psychosis',question:'Three?',choices:['A3','B3'],choiceLetters:['A','B'],correctLetter:'A',explanation:'z'}
]};

test('normalizes a valid bank and preserves bank-bound question ids',()=>{const [bank]=buildBankCatalog([definition]);assert.equal(bank.id,'bank-one');assert.equal(bank.questions.length,3);assert.equal(bank.byId.get('q2').correctLetter,'B')});

test('rejects duplicate bank and question ids',()=>{assert.throws(()=>buildBankCatalog([definition,definition]),/Duplicate bank id/);assert.throws(()=>buildBankCatalog([{...definition,questions:[definition.questions[0],definition.questions[0]]}]),/Duplicate question id/)});

test('rejects malformed questions before the app starts',()=>{assert.throws(()=>buildBankCatalog([{id:'bad',questions:[{id:'x',question:'Broken',choices:['Only one'],correctLetter:'A'}]}]),/Invalid question/)});

test('filters new incorrect and flagged pools without crossing bank state',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:false}],['q2',{timesUsed:1,isCorrect:true,isFlagged:true}]]);assert.deepEqual(chooseQuestionIds(bank,progress,'new',10,()=>0),['q3']);assert.deepEqual(chooseQuestionIds(bank,progress,'incorrect',10,()=>0),['q1']);assert.deepEqual(chooseQuestionIds(bank,progress,'flagged',10,()=>0),['q2'])});

test('combines multiple question statuses as a union while preserving legacy single pools',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:false}],['q2',{timesUsed:1,isCorrect:true,isFlagged:true}]]);assert.deepEqual(normalizeQuestionPools('new'),['new']);assert.deepEqual(eligibleQuestionIds(bank,progress,['new','incorrect']),['q1','q3']);assert.deepEqual(eligibleQuestionIds(bank,progress,['incorrect','flagged']),['q1','q2']);assert.deepEqual(eligibleQuestionIds(bank,progress,[]),[]);assert.deepEqual(eligibleQuestionIds(bank,progress,['all','incorrect']),['q1','q2','q3'])});

test('combines subject filters with all new used wrong and flagged pools',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:false}],['q2',{timesUsed:2,isCorrect:true,isFlagged:true}]]);assert.deepEqual(eligibleQuestionIds(bank,progress,'all',['Mood']),['q1','q2']);assert.deepEqual(eligibleQuestionIds(bank,progress,'used',['Mood']),['q1','q2']);assert.deepEqual(eligibleQuestionIds(bank,progress,'new',['Mood']),[]);assert.deepEqual(eligibleQuestionIds(bank,progress,'incorrect',['Mood']),['q1']);assert.deepEqual(eligibleQuestionIds(bank,progress,'flagged',['Mood']),['q2']);assert.deepEqual(eligibleQuestionIds(bank,progress,'new',['Psychosis']),['q3']);assert.deepEqual(eligibleQuestionIds(bank,progress,'all',[]),[])});

test('combines clinical subject and source-section filters without merging the dimensions',()=>{const [bank]=buildBankCatalog([{id:'spiegel-like',title:'Spiegel-like',questions:[{id:'t1',chapter:'test',chapterTitle:'Test 1',subjectTitle:'Mood',question:'One?',choices:['A','B'],correctLetter:'A',explanation:'x'},{id:'t2',chapter:'test',chapterTitle:'Test 2',subjectTitle:'Mood',question:'Two?',choices:['A','B'],correctLetter:'B',explanation:'y'},{id:'v1',chapter:'vignette',chapterTitle:'Vignette 1',subjectTitle:'Psychosis',linkedGroupId:'case-1',question:'Three?',choices:['A','B'],correctLetter:'A',explanation:'z'}]}]);assert.deepEqual(eligibleQuestionIds(bank,new Map(),'all',{subjects:['Mood'],sections:['Test 2']}),['t2']);assert.deepEqual(eligibleQuestionIds(bank,new Map(),'all',{subjects:['Psychosis'],sections:['Vignette 1']}),['v1']);assert.deepEqual(eligibleQuestionIds(bank,new Map(),'all',{subjects:['Mood'],sections:[]}),[])});

test('random selection never leaves the selected subjects',()=>{const [bank]=buildBankCatalog([definition]);const ids=chooseQuestionIds(bank,new Map(),'all',10,()=>0,['Psychosis']);assert.deepEqual(ids,['q3'])});

test('sequential selection preserves source question order',()=>{
  const [bank]=buildBankCatalog([definition]);
  const ids=chooseQuestionIds(bank,new Map(),'all',2,()=>0,null,false);
  assert.deepEqual(ids,['q1','q2']);
});

test('linked questions stay ordered and expand past the requested boundary',()=>{
  const [bank]=buildBankCatalog([{id:'linked',title:'Linked',questions:[
    {id:'case-1',chapterTitle:'Mood',linkedGroupId:'case-a',linkedOrder:0,question:'Case start?',choices:['A','B'],correctLetter:'A',explanation:'x'},
    {id:'case-2',chapterTitle:'Other',linkedGroupId:'case-a',linkedOrder:1,question:'Case follow-up?',choices:['A','B'],correctLetter:'B',explanation:'y'},
    {id:'solo',chapterTitle:'Other',question:'Solo?',choices:['A','B'],correctLetter:'A',explanation:'z'},
  ]}]);
  assert.deepEqual(chooseQuestionIds(bank,new Map(),'all',1,()=>0,['Mood']),['case-1','case-2']);
});

test('special criteria limit source question range and add flagged questions from another status pool',()=>{
  const [bank]=buildBankCatalog([definition]);
  const progress=new Map([
    ['q1',{timesUsed:1,isCorrect:true}],
    ['q2',{timesUsed:1,isCorrect:true,isFlagged:true}],
  ]);
  assert.deepEqual(
    chooseQuestionIds(bank,progress,'new',1,()=>0,null,false,{rangeStart:2,rangeEnd:3,includeFlagged:true}),
    ['q2']
  );
  assert.deepEqual(
    eligibleQuestionIds(bank,progress,'all',null,{rangeStart:2,rangeEnd:3}),
    ['q2','q3']
  );
});

test('special criteria keep linked follow-ups together when the range touches one member',()=>{
  const [bank]=buildBankCatalog([{id:'linked-range',title:'Linked range',questions:[
    {id:'case-1',linkedGroupId:'case',linkedOrder:0,question:'Case?',choices:['A','B'],correctLetter:'A',explanation:'x'},
    {id:'case-2',linkedGroupId:'case',linkedOrder:1,question:'Follow-up?',choices:['A','B'],correctLetter:'B',explanation:'y'},
    {id:'solo',question:'Solo?',choices:['A','B'],correctLetter:'A',explanation:'z'},
  ]}]);
  assert.deepEqual(
    chooseQuestionIds(bank,new Map(),'all',1,()=>0,null,false,{rangeStart:2,rangeEnd:2}),
    ['case-1','case-2']
  );
});

test('calculates answered omitted correct and incorrect totals',()=>{const [bank]=buildBankCatalog([definition]);const answers=new Map([['q1',{selectedAnswer:'A'}],['q2',{selectedAnswer:'A'}]]);assert.deepEqual(calculateSetResult(['q1','q2','q3'],answers,bank),{total:3,answered:2,omitted:1,correct:1,incorrect:1})});

test('builds category accuracy and timing statistics',()=>{const [bank]=buildBankCatalog([definition]);const progress=new Map([['q1',{timesUsed:1,isCorrect:true,totalTimeMs:1000}],['q2',{timesUsed:1,isCorrect:false,totalTimeMs:3000}]]);const mood=categoryStatistics(bank,progress).find(row=>row.title==='Mood');assert.equal(mood.answered,2);assert.equal(mood.correct,1);assert.equal(mood.accuracy,.5);assert.equal(mood.averageTimeMs,2000)});

test('keeps source test sections separate from clinical subject analytics',()=>{const [bank]=buildBankCatalog([{id:'dimensions',title:'Dimensions',questions:[{id:'q1',chapterTitle:'Test 1',subjectTitle:'Mood disorders',question:'One?',choices:['A','B'],correctLetter:'A',explanation:'x'},{id:'q2',chapterTitle:'Test 1',subjectTitle:'Psychotic disorders',question:'Two?',choices:['A','B'],correctLetter:'B',explanation:'y'}]}]);const progress=new Map([['q1',{timesUsed:1,isCorrect:true,totalTimeMs:1000}],['q2',{timesUsed:1,isCorrect:false,totalTimeMs:1000}]]);assert.deepEqual(categoryStatistics(bank,progress).map(row=>row.title),['Test 1']);assert.deepEqual(subjectStatistics(bank,progress).map(row=>row.title).sort(),['Mood disorders','Psychotic disorders'])});

test('uses one Test 1 section for a deck without source test divisions',()=>{const [bank]=buildBankCatalog([{id:'single-test',title:'Single Test',questions:[{id:'q1',subjectTitle:'Mood disorders',question:'One?',choices:['A','B'],correctLetter:'A',explanation:'x'}]}]);const progress=new Map([['q1',{timesUsed:1,isCorrect:true,totalTimeMs:1000}]]);assert.deepEqual(categoryStatistics(bank,progress).map(row=>row.title),['Test 1']);assert.deepEqual(subjectStatistics(bank,progress).map(row=>row.title),['Mood disorders'])});
