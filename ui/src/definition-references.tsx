import React from "react";
import type {SupportingReference} from "../../src/definition-references.js";

export function DefinitionReferences({references}: {references?: readonly SupportingReference[] | undefined}) {
  if (!references?.length) return null;
  return <div className="definition-references">
    <p><strong>References</strong></p>
    <ul>{references.map((reference, index) => <li key={index}>
      {typeof reference === "string" ? <>File: <code>{reference}</code></>
        : reference.skill.scope === "local" ? <>Local skill: <code>{reference.skill.path}</code></>
          : <>Global skill: <code>{reference.skill.name}</code></>}
    </li>)}</ul>
    <p className="small muted">Files and local skills are relative to the working checkout; global skills use the agent’s configured catalog. Shown read-only; file contents are not loaded or verified.</p>
  </div>;
}
