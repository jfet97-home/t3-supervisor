import React from "react";

export function DefinitionReferences({references}: {references?: readonly string[] | undefined}) {
  if (!references?.length) return null;
  return <div className="definition-references">
    <p><strong>References</strong></p>
    <ul>{references.map((path, index) => <li key={`${index}:${path}`}><code>{path}</code></li>)}</ul>
    <p className="small muted">File paths relative to the working checkout. Shown read-only; file contents are not loaded.</p>
  </div>;
}
