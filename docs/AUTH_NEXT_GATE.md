# Dashboard authentication — foundation shipped

Cookie sessions (`AUTH_SECRET` HMAC) with roles OWNER / ADMIN / CLIENT.
Login UI at `/login`. Middleware protects dashboard pages + private APIs.
Webhooks remain machine endpoints.

Still required before real-client go-live (owner action):
- Set `AUTH_SECRET` and at least owner credentials in Vercel
- Confirm Vercel Deployment Protection policy alongside app auth
- Optional: migrate from plaintext env passwords to hashed secrets store

Do not require HighLevel $497 OAuth for dashboard login.
