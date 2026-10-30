"""First launch: ZiggyBoss, the agent that customizes Ziggy One, and a first board to discover it.

ZiggyBoss is created at every start that finds no agent at all (fresh install, or every agent
closed): there is always a way to edit Ziggy One from itself. An existing user's agents are left
as they are. The "Board" is created once (onboarding.json in the data folder), if the Kanban is
empty at that moment.
"""

from pathlib import Path

from storage import read_json, write_json

BOSS_NAME = "ZiggyBoss"
BOSS_ROLE = "Customizes Ziggy One (the app that runs the agents) and fixes its bugs."
# First message of ZiggyBoss, sent when its terminal opens for the first time: it introduces itself.
BOSS_INTRO = (
    "You are ZiggyBoss, the agent in charge of Ziggy One itself: this folder is the code of the Ziggy One app the "
    "user is looking at right now (read README.md and CONTRIBUTING.md before changing anything). Introduce yourself "
    "to the user in 2 short sentences, no more: they can ask you to add features to Ziggy One or fix its bugs, and "
    "to help them use Ziggy One and organize their agents and tasks. Then wait for their request. Do not read or "
    "change any file before their request."
)
BOARD_NAME = "Board"
WELCOME_TITLE = "WELCOME/ Onboarding todo"
WELCOME_TICKET = """Things to try to discover Ziggy One. Tick each one when it is done.

**Agents**
- [ ] Open **ZiggyBoss** in the sidebar and read how it introduces itself
- [ ] Ask ZiggyBoss for a small change to Ziggy One (a color, a label, a shortcut…)
- [ ] Create an agent with **+ › Agent** and pick the folder it works in
- [ ] Give it a name, an avatar and a role (Configuration of the agent)
- [ ] Group agents in a workspace with **+ › Workspace**
- [ ] Look at the **Files** and **Git** tabs of an agent
- [ ] Type `!! ls` in the input to run a command without Claude

**Tasks**
- [ ] Drag this ticket to **In progress**
- [ ] Create a ticket and start its title with `FEATURE/` to tag it
- [ ] Ask an agent to read this ticket by its number ("read ticket #…")
- [ ] Archive the done tickets from the **Done** column

**Settings**
- [ ] Pick your language and corner style in **Configuration › General**
- [ ] Turn on desktop notifications in the account menu
"""


class Onboarding:
    def __init__(self, path):
        self._path = Path(path)

    def run(self, server, boss_cwd):
        """Creates ZiggyBoss (no agent yet) and, once, the welcome board (empty Kanban)."""
        if not server.conversations.list():
            conversation = server.conversations.open(cwd=str(boss_cwd), label=BOSS_NAME, intro=BOSS_INTRO)
            server.agents.rename(conversation.id, BOSS_NAME)
            server.agents.set_role(conversation.id, BOSS_ROLE)
            server.pins.add(conversation.id)
        if read_json(self._path, {}).get("done"):
            return
        if not server.kanban.list():
            board = server.kanban.create_board(BOARD_NAME)
            server.kanban.create_ticket(board["id"], board["columns"][0]["id"], WELCOME_TITLE, WELCOME_TICKET)
        write_json(self._path, {"done": True})
