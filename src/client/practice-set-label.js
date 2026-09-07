// Snapshot creation criteria into the existing synchronized test name field.
// Never derive an old test's filters from today's mutable progress or builder.
export function practiceSetLabel({mode,timed,secondsPerQuestion,randomized,pool=[],specialCriteria={},deckLabels=[],subjects=null,sections=null,filterDeck=''}) {
  const labels={all:'All questions',new:'New',used:'Used',incorrect:'Wrong',flagged:'Flagged'};
  const parts=[mode==='tutor'?'Tutor':'Test',deckLabels.join(' + '),pool.map(p=>labels[p]||p).join(specialCriteria.statusMatch==='and'?' AND ':' OR '),timed?`${secondsPerQuestion} sec/question`:'Untimed',randomized?'Randomized':'Source order'];
  parts.push(`${filterDeck ? filterDeck+' — ' : ''}Subjects: ${subjects===null?'All':subjects.join(', ')}`);
  parts.push(`Source tests: ${sections===null?'All':sections.join(', ')}`);
  if(specialCriteria.rangeStart!=null) parts.push(`Range: ${specialCriteria.rangeStart}–${specialCriteria.rangeEnd}`);
  if(specialCriteria.includeFlagged) parts.push(specialCriteria.statusMatch==='and'?'Flagged required':'Include flagged');
  const label=parts.filter(Boolean).join(' · ');
  if(label.length>8000) throw new Error('The test label is too long. Select fewer subject/source filters.');
  return label;
}
