// Hand-written fixture in the shape spike/dump_menu.mjs writes (supportedModels() and supportedCommands()). Made up.
window.MENU = {
 "models": [
  { "value": "default", "name": "Default", "description": "Use the default model (currently Fixture Large (Default))", "effort": ["low", "medium", "high"] },
  { "value": "fixture-large", "name": "Fixture Large", "description": "The larger fixture model", "effort": ["low", "medium", "high"] },
  { "value": "fixture-small", "name": "Fixture Small", "description": "The fast fixture model", "effort": [] }
 ],
 "commands": [
  { "name": "clear", "description": "Clear the conversation", "hint": "" },
  { "name": "compact", "description": "Summarise the conversation to free context", "hint": "[instructions]" },
  { "name": "model", "description": "Choose the model for this session", "hint": "" },
  { "name": "plan", "description": "Plan before changing files", "hint": "" },
  { "name": "pr-review", "description": "Review a pull request", "hint": "<number>" },
  { "name": "release-notes", "description": "Draft release notes from merged work", "hint": "" },
  { "name": "fixture:deploy", "description": "Deploy the fixture app", "hint": "<env>" },
  { "name": "__internal", "description": "Hidden from the menu", "hint": "" }
 ]
};
