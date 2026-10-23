import React from "react";
import type {DefinitionGuidance} from "../../src/definition-references.js";

export function DefinitionReferences({references, skills}: {references?: DefinitionGuidance["references"]; skills?: DefinitionGuidance["skills"]}) {
  return <>
    {!!references?.length && <div className="definition-references">
      <p><strong>References</strong></p>
      <ul>{references.map((reference, index) => <li key={index}><code>{reference}</code></li>)}</ul>
      <p className="small muted">Relative to the working checkout. Shown read-only; file contents are not loaded or verified.</p>
    </div>}
    {!!skills?.length && <div className="definition-references">
      <p><strong>Skills</strong></p>
      <ul>{skills.map((skill, index) => <li key={index}><code>{skill}</code></li>)}</ul>
      <p className="small muted">Local paths use the working checkout; names use the agent’s configured catalog. Shown read-only; skills are not loaded or verified.</p>
    </div>}
  </>;
}
