// Did the research brief find that the trial's own result is already out?
// Briefs open with a status line. Early briefs used "RESULT ALREADY PUBLIC:"
// and sometimes answered it with "No", so the words after the marker decide.
export function resultIsPublic(brief) {
  const head = brief.slice(0, 400);
  if (/RESULT STATUS:\**\s*NOT PUBLIC/i.test(head)) return false;
  if (/RESULT STATUS:\**\s*PUBLIC/i.test(head)) return true;
  const m = head.match(/RESULT ALREADY PUBLIC:?\**:?\s*(.{0,30})/i);
  if (!m) return false;
  return !/^(no\b|not\b|none\b|n\/a)/i.test(m[1].trim());
}
