// node:test reporter used by scripts/run-node-tests.js. It writes one JSON line
// per enqueued, passed or failed test or suite, so the runner can check that
// every test file ran its tests to the end.
export default async function* events(source) {
  for await (const { type, data } of source) {
    if (type !== "test:enqueue" && type !== "test:pass" && type !== "test:fail") continue;
    yield JSON.stringify({
      type,
      file: data.file || null,
      name: data.name,
      nesting: data.nesting,
      kind: (data.details && data.details.type) || null,
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
    }) + "\n";
  }
}
