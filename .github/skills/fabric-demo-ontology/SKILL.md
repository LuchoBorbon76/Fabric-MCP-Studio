---
name: fabric-demo-ontology
description: Demo step 4 - create or evolve a Fabric IQ ontology (entities, relationships, business rules) as TMDL from a semantic model or a business glossary, review it like code, and deploy it to Fabric. Use when the user asks to build an ontology, add business rules, turn a glossary into an ontology, or do ontology-as-code.
---

# Ontology as code

Two entry points – pick based on what the user has:

- **A. From a semantic model** – reuse the business meaning already in `Retail Sales` (or a customer model).
- **B. From a glossary or policy document** – e.g. [data/retail/business-glossary.md](../../../data/retail/business-glossary.md).

Both end with TMDL files under `ontology/<domain>/`, a reviewed diff, and a deployed Ontology item.
Follow the TMDL rules in [AGENTS.md](../../../AGENTS.md) and copy the shape of [ontology/retail](../../../ontology/retail).

## A. From a semantic model

1. Read the model: `powerbi-authoring` (tables, columns, relationships, measures, descriptions) or
   `fabric-core` get_item_definition on the SemanticModel.
2. Map it:

   | Semantic model | Ontology |
   |---|---|
   | Dimension or fact table | `entity` + backing `table` (skip the `Date` table) |
   | Column | `property` (keep descriptions as `///` doc comments) |
   | Relationship | `relationship` (table join) + `entityRelationship` with a business name (`'Sale By Customer'`) |
   | Business definition in measure descriptions / glossary | `rule` with a one-line `statement` |

3. Bind entities to the **lakehouse tables** (Direct Lake partitions using the `DatabaseQuery` expression), exactly
   like `ontology/retail/tables/*.tmdl`.
4. Measures as **metrics**: the most reliable path today is Fabric's *Generate ontology from semantic model* in the
   UI, which carries DAX measures over as source-owned metrics. If the user wants that, have them run it, then pull
   the result into the repo with `fabric-core` get_item_definition (decode the base64 parts into `ontology/<domain>/`)
   so it is version-controlled from then on.

## B. From a glossary (rules and descriptions)

1. Read the glossary. For each entity definition update the entity `///` description; for each business rule or
   classification create `rules/<PascalCaseName>.tmdl` with `statement`, `ruleReferencedEntity`,
   `ruleReferencedProperty` (with `propertyScope: specific`) and `ruleReferencedRelationship` as needed.
2. Add `ref rule <Name>` to `model.tmdl`. New GUIDs for new `lineageTag`s; never change existing ones.
3. Show a table of rules: name · statement · entities/properties referenced · glossary line it came from.

## Review and deploy (both paths)

1. Create a branch `ontology/<short-description>`, commit, and show `git diff --stat` plus the full diff of rules.
   If `gh` is available and the user agrees, open a pull request – this is the governance moment of the demo.
2. Deploy after approval:

   ```powershell
   .\scripts\deploy-ontology.ps1 -SourceFolder .\ontology\<domain> -OntologyName "<name>"
   ```

   (Without a terminal, use `fabric-core` create_item / update_item_definition with the base64 parts that
   `deploy-ontology.ps1 -DryRun` writes to `config/ontology.payload.json`.)
3. Verify: `fabric-core` get_item_definition, decode, and confirm entities/rules round-tripped.
4. Expose it to agents: `.\scripts\setup.ps1 -Client <client> -IncludeOntology`, reload MCP servers, then use the
   `fabric-demo-ask` skill.

## Gotchas

- Ontology is **preview**; on a trial capacity the Ontology MCP endpoint lists entities and rules, but `ask_ontology` questions can time out; use a paid F2+ (or P1+) capacity for reliable answers.
- Tabs, not spaces. One rule per file. File name = element `name`.
- Keep rule statements free of colons; keep them to one sentence where possible.
- If deployment fails with a parse error, run `-DryRun`, decode the failing part, and fix indentation first.
