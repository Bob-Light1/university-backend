# Manual QA cases

[admission.cases.json](admission.cases.json) is the durable source for
ERP-ADM-001–005 in the independent QA Workbench. The
[admission feature note](../../docs/architecture/features/online-admission.md)
owns delivery status, registration evidence and remaining gates. Preparing this
payload does not register cases or record passed executions.

Use the Workbench's documented CLI with its own Node 24 runtime, hosted
publishable configuration and a current project-scoped editor/admin identity.
Verify membership in **ERP multi-campus** before importing. Supply credentials
through the secure environment; never put them in a command argument, case body,
commit or screenshot. Do not use a service key to change membership.

From the separate Workbench checkout, run its existing import command with the
verified ERP project ID and this file's absolute path:

```sh
npm run qa -- import PROJECT_UUID /absolute/backend/tests/manual/admission.cases.json
```

The CLI uses the same optimistic `save_case` RPC as the UI. Identical bodies are
skipped; changed cases receive a new revision. Existing campaign snapshots and
submitted executions must remain untouched. Case registration is separate from
creating a campaign, executing it or obtaining independent CH-* acceptance.

Run these cases only against an owned local synthetic ERP environment. Accounts,
activation codes and private candidate links are provided separately. Use the
recorded build references and capture the observed outcome rather than inferring
success from automated test results.

## WhatsApp Business

[whatsapp.cases.json](whatsapp.cases.json) owns ERP-WA-001–005. Import it with the
same verified ERP editor identity and existing CLI. The
[WhatsApp feature note](../../docs/architecture/features/whatsapp-business.md)
owns acceptance and the real-provider activation boundary. Provider checks use
an owned intercepted transport, never actual paid sends or real contact data.
No campaign/execution is created by registration.
