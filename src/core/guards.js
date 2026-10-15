'use strict';

// Detects replies where a model claims it has no access to the computer, or explains
// how to do something by hand instead of doing it, although it has tools for that.
// The agent loop uses these to send the model back to use its tools.

const DENIAL_PATTERNS = [
  // "I can't perform actions directly on your computer", "I don't have the ability to access your file system"
  /\b(can(?:'|’)?t|cannot|can not|unable to|not able to|(?:do not|don(?:'|’)?t) have (?:the )?(?:ability|access|capability|permission)|not capable of|no (?:way|ability) to)\b[^.!?\n]{0,80}\b(file ?system|your (?:computer|pc|device|machine|desktop|files?|folders?|system|drive)|local (?:files?|system|machine|computer)|directly (?:on|interact|access|perform|create|modify|run|execute|make)|execute (?:commands?|code|programs?)|run (?:commands?|code|programs?)|create (?:files?|folders?|directories)|browse|the internet|access the web|perform (?:actions|tasks|operations))/i,
  /\bas an ai\b[^.!?\n]{0,80}\b(can(?:'|’)?t|cannot|don(?:'|’)?t|do not|unable|no ability)\b/i,
  /\b(you(?:'ll| will) need to|you have to|you must)\s+(?:do (?:this|it) )?(?:manually|yourself)\b/i,
];

const ACTION_REQUEST = [
  /\b(create|make|add|delete|remove|move|rename|copy|put|save|write|open|organi[sz]e|clean up)\b[^.?!\n]{0,50}\b(folders?|director(?:y|ies)|files?|desktop|documents|downloads)\b/i,
  /\b(run|execute|install|start|launch|build|test|compile)\b[^.?!\n]{0,40}\b(commands?|scripts?|programs?|it|this|npm|pip|python|node|java|gradle|tests?|project|app)\b/i,
  /^\s*(you do it|do it|just do it|go ahead|do that|please do it)\b/i,
];

// "Would you like me to proceed?" after being asked to do something.
const CONFIRM_REPLY = /\b(would you like (?:me )?to (?:proceed|continue|go ahead|start|do (?:this|that|it))|shall i (?:proceed|continue|go ahead|start)|should i (?:proceed|go ahead|continue|start)|do you want me to (?:proceed|continue|go ahead|start|do)|let me know if you(?:'d| would)? (?:like|want) me to (?:proceed|continue|go ahead|start))\b/i;

const INSTRUCTIONS_REPLY = /\b(here are the steps|follow these steps|steps to|you can do this by|you can create|you can make|i can (?:help )?guide you|right-click|open (?:your )?file explorer|open (?:the )?terminal and)\b/i;

function looksLikeCapabilityDenial(reply) {
  const text = String(reply || '');
  return DENIAL_PATTERNS.some((re) => re.test(text));
}

function isActionRequest(request) {
  const text = String(request || '');
  return ACTION_REQUEST.some((re) => re.test(text));
}

/**
 * Why the model should be sent back to work, or null:
 *  'denial'       – claims it can't access the computer
 *  'instructions' – explains manual steps for an action request without using a tool
 *  'confirm'      – stops to ask "shall I proceed?" on an action request
 */
function nudgeReason({ request, reply, usedTools }) {
  const text = String(reply || '');
  if (looksLikeCapabilityDenial(text)) return 'denial';
  const action = isActionRequest(request);
  if (!usedTools && action && INSTRUCTIONS_REPLY.test(text)) return 'instructions';
  if (action && CONFIRM_REPLY.test(text)) return 'confirm';
  return null;
}

function shouldNudgeToolUse(args) {
  return nudgeReason(args) !== null;
}

module.exports = { looksLikeCapabilityDenial, isActionRequest, nudgeReason, shouldNudgeToolUse };
