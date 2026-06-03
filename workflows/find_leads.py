from brain.agent import run_agent


def find_leads_workflow(
    companies: list[str],
    titles: list[str],
    client_name: str = "Intellectible",
    target_description: str = "",
):
    profile_line = f"\nTARGET DESCRIPTION: {target_description}" if target_description else ""
    prompt = f"""
    Run a lead research workflow:{profile_line}
    COMPANIES TO RESEARCH: {', '.join(companies)}
    DECISION-MAKER TITLES: {', '.join(titles)}

    For each company:
    1. Use find_company to get firmographic data and confirm they fit the ICP
    2. Use find_contacts to find decision-makers matching the given titles
    3. Use enrich_contact on the top 2 contacts per company to get verified email and LinkedIn

    Output a clean list of qualified leads with: name, title, company, email, and a one-line
    reason why they fit the ICP. Flag any companies that don't fit and explain why.
    """
    return run_agent(prompt, client_name=client_name)
