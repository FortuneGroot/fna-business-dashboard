from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "src" / "content"
CONTENT.mkdir(parents=True, exist_ok=True)

EMAILS = [
    {"id": "EMAIL-001", "name": "New Inquiry", "subject": "We received your request", "classification": "Service",
     "body": "Hi there,\n\nThanks for contacting [[CV:Business Name]]. We have your request and will review it during [[CV:Business Hours]]. If you want to add a detail, reply to this email. You can also choose a conversation time: [[CV:Booking URL]].\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-002", "name": "Appointment Confirmation", "subject": "Your appointment details", "classification": "Appointment",
     "body": "Hi there,\n\nYour appointment with [[CV:Business Name]] is booked.\nWhen: [[APPT:Start]] ([[APPT:Timezone]])\nWhere: [[APPT:Location]]\nChange your appointment: [[APPT:Reschedule URL]]\nCancel: [[APPT:Cancellation URL]]\nIf you have a question, reply here.\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-003", "name": "Appointment Reminder", "subject": "A reminder about your appointment", "classification": "Appointment",
     "body": "Hi there,\n\nWe look forward to speaking with you at [[APPT:Start]] ([[APPT:Timezone]]).\nDetails: [[APPT:Location]]\nNeed to change your time? [[APPT:Reschedule URL]]\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-004", "name": "Proposal Follow-Up", "subject": "Any questions about your estimate?", "classification": "Proposal",
     "body": "Hi there,\n\nOur team at [[CV:Business Name]] is following up on the estimate we sent. If you have questions about the scope or next steps, reply here. Any price or scope change will be confirmed by our team.\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-005", "name": "Educational Follow-Up", "subject": "Planning your next step", "classification": "Marketing",
     "body": "Hi there,\n\nIf you are comparing options, it can help to list what you need, when you need it and the questions you want answered. Our team at [[CV:Business Name]] can talk through those details with you.\nChoose a time if useful: [[CV:Booking URL]].\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-006", "name": "Customer Thank You", "subject": "Thank you for choosing us", "classification": "Customer service",
     "body": "Hi there,\n\nThank you for choosing [[CV:Business Name]]. Our team will confirm the next steps for your service. If you have questions in the meantime, reply here.\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-007", "name": "Review Request", "subject": "Would you share your experience?", "classification": "Review",
     "body": "Hi there,\n\nThank you for working with [[CV:Business Name]]. You are welcome to leave an honest public review here: [[CV:Review URL]]. We appreciate hearing about your experience. If you prefer to contact us directly as well, reply to this email.\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-008", "name": "Reactivation", "subject": "Do you still need a hand?", "classification": "Marketing",
     "body": "Hi there,\n\nYou previously contacted [[CV:Business Name]] about our services. If that request is still relevant, reply and tell us what you need. If your plans changed, no problem.\n\n[[CV:Business Name]]\n[[CV:Address]], [[CV:City]], [[CV:State]] [[CV:ZIP]]\n[[CV:Support Email]]\nUnsubscribe: [[LINK:Unsubscribe]]"},
    {"id": "EMAIL-009", "name": "Human Follow-Up Required", "subject": "A conversation needs your attention", "classification": "Internal",
     "body": "Internal only.\nContact: [[CONTACT:Full Name]]\nReason: [[CONTACT:AI Escalation Reason]]\nSummary: [[CONTACT:AI Lead Summary]]\nOpen contact: [[CONTEXT:Contact URL]]\nClaim the conversation, review the request and set a next action."},
]

SMS = [
    ("SMS-001", "Thanks for contacting [[CV:Business Name]]. We received your request. What would you like help with? Reply STOP to opt out."),
    ("SMS-002", "Hi, this is [[CV:Business Name]]. Sorry we missed your call. How can we help? Reply STOP to opt out."),
    ("SMS-003", "Thanks for contacting [[CV:Business Name]]. [[CV:After Hours Message]] What can we help with? Reply STOP to opt out."),
    ("SMS-004", "Hi, [[CV:Business Name]] here. Do you still need help with your request? You can reply here. Reply STOP to opt out."),
    ("SMS-005", "This is [[CV:Business Name]]. If you would like to talk through your request, choose a time here: [[CV:Booking URL]]. Reply STOP to opt out."),
    ("SMS-006", "Your appointment with [[CV:Business Name]] is booked for [[APPT:Start]] ([[APPT:Timezone]]). Details: [[APPT:Location]]. To change it: [[APPT:Reschedule URL]]. Reply STOP to opt out."),
    ("SMS-007", "A reminder from [[CV:Business Name]]: your appointment is [[APPT:Start]] ([[APPT:Timezone]]). Need another time? [[APPT:Reschedule URL]] Reply STOP to opt out."),
    ("SMS-008", "Your appointment with [[CV:Business Name]] starts at [[APPT:Start]] ([[APPT:Timezone]]). Details: [[APPT:Location]]. Reply STOP to opt out."),
    ("SMS-009", "Your appointment with [[CV:Business Name]] has been moved to [[APPT:Start]] ([[APPT:Timezone]]). To make another change: [[APPT:Reschedule URL]]. Reply STOP to opt out."),
    ("SMS-010", "Your appointment with [[CV:Business Name]] for [[APPT:Start]] ([[APPT:Timezone]]) has been cancelled. You can book again here: [[CV:Booking URL]]. Reply STOP to opt out."),
    ("SMS-011", "Hi, [[CV:Business Name]] here. We were unable to connect at your appointment. If another time works better, you can book here: [[CV:Booking URL]]. Reply STOP to opt out."),
    ("SMS-012", "Hi, this is [[CV:Business Name]]. Do you have any questions about the estimate we sent? Reply here and our team can help. Reply STOP to opt out."),
    ("SMS-013", "Hi, [[CV:Business Name]] here. If your plans have changed and you would like help, you can reply or book a conversation: [[CV:Booking URL]]. Reply STOP to opt out."),
    ("SMS-014", "Hi, this is [[CV:Business Name]]. You previously asked us about our services. Is this still something you need help with? Reply STOP to opt out."),
    ("SMS-015", "Thank you for choosing [[CV:Business Name]]. If you have a question about the next steps, reply here and our team will help. Reply STOP to opt out."),
    ("SMS-016", "Thank you for working with [[CV:Business Name]]. If you would like to share your experience, you can leave an honest review here: [[CV:Review URL]]. Reply STOP to opt out."),
    ("SMS-017", "I will pass this to the team at [[CV:Business Name]]. They can help with your question. [[CV:After Hours Message]] Reply STOP to opt out."),
    ("SMS-018", "This is [[CV:Business Name]]. We will close this follow-up for now. If you need us later, just get in touch. Reply STOP to opt out."),
    ("SMS-019", "Hi, [[CV:Business Name]] here. We will pause our estimate follow-up now. If you have questions later, our team can help. Reply STOP to opt out."),
    ("SMS-020", "A quick reminder from [[CV:Business Name]]: if you want to share your experience, here is the review link: [[CV:Review URL]]. Thank you. Reply STOP to opt out."),
    ("SMS-021", "This is [[CV:Business Name]]. We will leave this with you. If you want help with your earlier request, reply here. Reply STOP to opt out."),
]

SNIPPETS = [
    {"id": "SNIP-01", "title": "New inquiry ack", "body": "Thanks for contacting Fortune & Automations. We have your request and will review it during business hours."},
    {"id": "SNIP-02", "title": "Ask for details", "body": "Thanks — could you share a bit more about whether this is Automation, Websites, Branding, or Systems work?"},
    {"id": "SNIP-03", "title": "Booking offer", "body": "If you would rather talk it through, you can choose a time on our calendar. A form request is not a reserved appointment."},
    {"id": "SNIP-04", "title": "After hours", "body": "Thanks for writing. Our team reviews requests during business hours (US/Eastern). We will follow up using the contact method you provided."},
    {"id": "SNIP-05", "title": "Human handoff", "body": "I will pass this to the Fortune & Automations team so a person can help with your question."},
    {"id": "SNIP-06", "title": "No pricing on chat", "body": "Scope, pricing, and availability are confirmed by the team after we review your request. I do not quote a number here."},
    {"id": "SNIP-07", "title": "STOP received", "body": "You are opted out of texts from Fortune & Automations. We will not send further marketing or service texts to this number."},
    {"id": "SNIP-08", "title": "Estimate follow-up", "body": "Checking in on the estimate we sent. If you have questions about scope or next steps, reply here. Any price change will be confirmed by our team."},
    {"id": "SNIP-09", "title": "Thank you / won", "body": "Thank you for choosing Fortune & Automations. Our team will confirm the next steps for your service."},
    {"id": "SNIP-10", "title": "Review invite", "body": "If you would like to share an honest public review of your experience, I can send the review link. There is no pressure either way."},
    {"id": "SNIP-11", "title": "Emergency deflect", "body": "If this is an emergency or someone is in danger, please contact local emergency services. Fortune & Automations cannot replace 911."},
    {"id": "SNIP-12", "title": "Existing customer support", "body": "Thanks — I will treat this as a support request for an existing project rather than a new sales inquiry."},
]


def main() -> None:
    (CONTENT / "emails.json").write_text(json.dumps(EMAILS, indent=2) + "\n", encoding="utf-8")
    (CONTENT / "sms.json").write_text(json.dumps([{"id": i, "text": t} for i, t in SMS], indent=2) + "\n", encoding="utf-8")
    (CONTENT / "snippets.json").write_text(json.dumps(SNIPPETS, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"emails": len(EMAILS), "sms": len(SMS), "snippets": len(SNIPPETS)}))


if __name__ == "__main__":
    main()
