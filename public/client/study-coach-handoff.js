// Derive handoff guidance from existing exchange metadata; no new stored state.
export function studyCoachHandoff(status, installedOutput = null) {
  if (!status.enabled || !status.exchangeEnabled) return "Turn on Study Coach access to use the Cloudflare exchange.";
  const pkg = status.latestPackage;
  const output = status.latestOutput;
  if (!pkg?.exportedAt) return "No verified package timestamp. Send latest package to begin.";
  if (!output?.generatedAt || output.sourcePackageGeneratedAt !== pkg.exportedAt) {
    return "Package sent · awaiting analysis for this package. Ask Codex here to analyze it; sending does not automatically run the coach. Earlier installed material remains available.";
  }
  if (installedOutput?.generatedAt === output.generatedAt && installedOutput?.sourcePackageGeneratedAt === pkg.exportedAt) {
    return "Latest coach output installed · open Study Coach Question Bank in the Deck Library.";
  }
  return "New coach output ready for this package · select Update Study Coach to install it.";
}
