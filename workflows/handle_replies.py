from brain.agent import run_agent


# Inbound spam is a real share of these inboxes: on 2026-09-09/10 Supply Wisdom
# received 44 unsolicited business-funding blasts, each from a different
# throwaway domain, and the categoriser scored 4 of them "Interested" and 1
# "Information Request". Anything that auto-sends off that label will reply to
# spammers — which confirms the mailbox is live and burns sending reputation.
# Hence: spam is an explicit class, and sending is opt-in rather than automatic.
def handle_replies_workflow(client_name: str = "Intellectible", send: bool = False):
    send_step = (
        "5. For replies classified 'interested', draft a short personalized follow-up using the "
        "client's voice, then use send_reply to send it. Never send to anything classified 'spam' "
        "or 'automated', and never send to a sender whose domain does not belong to a real "
        "prospect — when in doubt, draft it and report it instead of sending."
        if send else
        "5. For replies classified 'interested', draft a short personalized follow-up using the "
        "client's voice and INCLUDE THE DRAFT IN YOUR SUMMARY. Do not call send_reply — sending "
        "is disabled for this run so a misclassified reply cannot be answered automatically."
    )
    prompt = f"""
    Check the inbox for new replies and handle them:

    1. Use list_replies to get recent replies (limit 20)
    2. For any reply that looks genuinely interested or needs a response, use get_reply_thread to read the full thread
    3. Classify each reply: interested / not_interested / follow_up / wrong_person / ooo / spam

       'spam' means unsolicited mail that is not a reply to our campaign — business funding or
       loan offers, merchant cash advance, debt relief, SEO/lead-gen pitches, newsletters. Tells:
       the sender domain is unrelated to the prospect's company, the domain looks freshly
       registered or disposable, the pitch targets US as a business rather than answering our
       message, or a 'Re:' subject that does not match any thread we started. Sales language
       aimed at us ("funding available", "lower rates", "let's get in touch") is NOT buying
       intent — classify it spam, never interested.

    4. Use tag_reply to label each one appropriately. Label spam 'Automated Response' unless the
       workspace has a dedicated spam label; do NOT label it 'Interested' or 'Information Request'.
    {send_step}
    6. Summarize: how many replies reviewed, how many interested, how many spam, what was drafted
       or sent. List any reply you were unsure about rather than guessing.
    """
    return run_agent(prompt, client_name=client_name)
