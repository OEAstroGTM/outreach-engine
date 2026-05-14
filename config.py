import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
EMAILBISON_API_KEY = os.getenv("EMAILBISON_API_KEY")
INSTANTLY_API_KEY = os.getenv("INSTANTLY_API_KEY")
MASTERINBOX_API_KEY = os.getenv("MASTERINBOX_API_KEY")
CLAY_API_KEY = os.getenv("CLAY_API_KEY")

CLAUDE_MODEL = "claude-sonnet-4-6"
