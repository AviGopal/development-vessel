import scaffoldAndPublishVessel from './activities/scaffold-and-publish-vessel.js';
import type { ActivityTemplate } from './types/activity-template.js';

/**
 * Returns all activity templates registered for this vessel.
 * Templates with boredom_target_template=true are eligible for boredom-selector routing.
 */
export function getRegisteredTemplates(): ActivityTemplate[] {
  return [scaffoldAndPublishVessel];
}

/**
 * Look up a template by id.
 */
export function findTemplate(id: string): ActivityTemplate | undefined {
  return getRegisteredTemplates().find((t) => t.id === id);
}

/**
 * Return templates eligible for boredom-selector routing.
 */
export function getBoredomTargetTemplates(): ActivityTemplate[] {
  return getRegisteredTemplates().filter((t) => t.boredom_target_template);
}
