// Purpose: versioned, content-free clinical-label review for the pinned Spiegel
// source. IDs alone are not authority: a different source revision must be reviewed
// before reusing this mapping. Unreviewed items retain the legacy inferred label.
export const REVIEWED_SPIEGEL_SOURCE = "f5c34b4ef2ad";
export const SPIEGEL_SUBJECT_REVISION = "v3";
export const REVIEWED_SPIEGEL_SUBJECTS = Object.freeze({
  "test1-q57": "Contributions from the Neurosciences",
  "test3-q20": "Contributions from the Neurosciences",
  "test3-q40": "Contributions from the Neurosciences",
  "test3-q44": "Contributions from the Neurosciences",
  "test4-q12": "Contributions from the Neurosciences",
  "test4-q22": "Psychopharmacology",
  "test5-q7": "Psychopharmacology",
  "test5-q26": "Contributions from the Neurosciences",
  "test5-q75": "Contributions from the Behavioral and Social Sciences",
  "test6-q13": "Psychopharmacology",
  "test6-q27": "Normal Development and Aging",
  "vign12-q3": "Psychopharmacology",
  "vign15-q1": "Dissociative Disorders",
  "vign15-q2": "Dissociative Disorders",
  "vign15-q3": "Dissociative Disorders",
});

export function reviewedSpiegelSubject(questionId, sourceChecksum) {
  return sourceChecksum?.slice(0, 12) === REVIEWED_SPIEGEL_SOURCE
    ? REVIEWED_SPIEGEL_SUBJECTS[questionId] || null
    : null;
}
