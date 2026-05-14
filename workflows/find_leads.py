from brain.agent import run_agent


def find_leads_workflow(target_description: str, companies: list[str], titles: list[str]):
    prompt = f"""
    Run a lead research workflow:

    TARGET PROFILE: {target_description}
    COMPANIES TO RESEARCH: {', '.join(companies)}
    DECISION-MAKER TITLES: {', '.join(titles)}

    For each company:
    1. Use find_company to get firmographic data
    2. Use find_contacts to find decision-makers with the given titles
    3. Use enrich_contact on the top 2-3 contacts per company

    Summarize the best leads found and why they fit the target profile.
    """
    return run_agent(prompt)
