from brain.agent import run_agent


def handle_replies_workflow(client_name: str = "Intellectible"):
    prompt = """
    Check the inbox for new replies and handle them:

    1. Use list_replies to get recent replies (limit 20)
    2. For any reply that looks genuinely interested or needs a response, use get_reply_thread to read the full thread
    3. Classify each reply: interested / not_interested / follow_up / wrong_person / ooo
    4. Use tag_reply to label each one appropriately
    5. For replies tagged as 'interested', draft a short personalized follow-up using the client's voice — then use send_reply to send it
    6. Summarize: how many replies reviewed, how many interested, what follow-ups were sent
    """
    return run_agent(prompt, client_name=client_name)
