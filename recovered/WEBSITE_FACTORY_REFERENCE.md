# F&A Universal Website Starter Reference

Permanent code source of truth:
- GitHub repository: FortuneandFinance/0bos
- Branch: main
- Final master commit (2026-09-06): 7e745759d0d024a1863ea8f876038e7262ad9a8a

This operating-system package intentionally does NOT duplicate the website source code.
Keep the website factory in its own repository. Never put client-specific data into the permanent master.

Client flow: create a private client copy -> run client:init with intentional master conversion -> use verified/client-approved facts -> customize -> connect GHL -> validate:client -> qa:full -> preview -> approval -> production -> live lead test.
