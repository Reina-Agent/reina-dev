export const description = [
  "Maintain a visible task list. Use proactively for 3+ distinct steps or multi-part user requests; skip for trivial tasks.",
  "",
  "Each todo has `content` (imperative, e.g. 'Run tests'), `activeForm` (present-continuous, e.g. 'Running tests' — required so the UI shows natural progress text), and `status` (`pending`/`in_progress`/`completed`).",
  "",
  "Keep exactly one item `in_progress` at a time. Mark items completed as soon as done — don't batch.",
].join("\n");
