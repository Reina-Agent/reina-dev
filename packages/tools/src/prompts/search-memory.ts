export const description = [
  "Keyword search across this workspace's long-term memory: EVERY session's conversation history (full-text), offloaded compaction chunks, and the notes indexes.",
  "Use it to recover context that is no longer in your window — details lost to compaction, or work done in an earlier session ('did we already debug X?', 'what did the user decide about Y?').",
  "Each hit carries a pointer to pull the full content: recall_memory_chunk(id) for chunks, read_note(id) for notes; history hits show a snippet inline.",
  "Bare words AND together; \"quoted phrases\" match exactly. Keep queries to 1-3 concrete terms (identifiers, filenames, error strings work best).",
].join("\n");
