from brain.agent import run_agent


def handle_replies_workflow():
    prompt = """
    Check the inbox for new replies and handle them:

    1. Use list_replies to get recent untagged replies
    2. For each reply, use get_reply_thread to read the full conversation
    3. Classify the reply as: interested / not_interested / follow_up / wrong_person / timing
    4. Use tag_reply to label each one
    5. For replies tagged as 'interested', draft and send a personalized follow-up using send_reply
    6. Summarize what you found and what actions you took
    """
    return run_agent(prompt)
