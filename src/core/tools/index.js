'use strict';

// Tool registry. To add a tool: create a module exporting
// { name, category, description, parameters, summarize(args), run(args, ctx) }
// and register it below. `category` drives permissions:
//   read    – always available when a project is open
//   edit    – file changes (persona permission "edit")
//   command – shell commands (persona permission "commands")
//   web     – network access (persona permission "web")
//   plan    – progress tracking, always available

const files = require('./files');
const { runCommandTool } = require('./command');
const { fetchUrlTool, webSearchTool } = require('./web');
const { updatePlanTool } = require('./plan');

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    for (const key of ['name', 'category', 'description', 'parameters', 'run']) {
      if (!tool[key]) throw new Error(`Tool is missing "${key}"`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  /**
   * Tools the model may use, given the persona permissions and whether a project is open.
   */
  available({ permissions = {}, hasProject = true } = {}) {
    return [...this.tools.values()].filter((t) => {
      switch (t.category) {
        case 'read':
          return hasProject;
        case 'edit':
          return hasProject && permissions.edit !== 'off';
        case 'command':
          return hasProject && permissions.commands !== 'off';
        case 'web':
          return permissions.web !== 'off';
        default:
          return true;
      }
    });
  }

  // Ollama/OpenAI function-calling schema.
  static schemas(tools) {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
}

function createDefaultRegistry() {
  return new ToolRegistry()
    .register(files.listFiles)
    .register(files.readFile)
    .register(files.searchFiles)
    .register(files.writeFile)
    .register(files.editFile)
    .register(files.deleteFile)
    .register(files.createFolder)
    .register(files.movePath)
    .register(runCommandTool)
    .register(webSearchTool)
    .register(fetchUrlTool)
    .register(updatePlanTool);
}

module.exports = { ToolRegistry, createDefaultRegistry };
