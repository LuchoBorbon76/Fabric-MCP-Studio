# Azure AI Foundry agent (bring your own model)

For customers who want to choose the model deployment, network boundary and content filters themselves.

## Option A – Fabric IQ tool (recommended)

Foundry Agent Service can register **Fabric IQ** as a server-side tool, so the agent delegates natural-language
questions to Fabric (data agents and Power BI semantic models), using the identity configured on the
connection and honoring Fabric permissions.

Follow [Connect agents to Microsoft Fabric with Fabric IQ (preview)](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq):

1. Foundry project with a deployed model (any model the customer is licensed for).
2. Add a Fabric IQ connection pointing at the **Retail_SM_Sales_DEMO** semantic model. (Ontology questions are turned off
   in this kit for now; use Option B to give the agent the ontology's entities and rules.)
3. Add the tool to the agent and use the instructions from [copilot-studio/README.md](../copilot-studio/README.md#3-instructions-for-the-agent).

Check the article's region, VNet and data-boundary notes with the customer's security team first.

## Option B – Remote MCP tool

Agents that support remote MCP tools can call the same endpoints as every other client:

| Purpose | URL |
|---|---|
| Ask questions over semantic models | `https://fabriciq.svc.cloud.microsoft/v1/mcp/fabriciq` |
| Ontology context | `https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/<workspaceId>/items/<ontologyId>/ontologyEndpoint` – set the tool's allowed tools to `list_ontology_entities` and `list_ontology_rules` (ontology questions are turned off for now) |

Authentication is delegated Microsoft Entra ID (service principals aren't supported by Fabric IQ MCP or the
Ontology MCP endpoint today), so use an on-behalf-of user flow.
