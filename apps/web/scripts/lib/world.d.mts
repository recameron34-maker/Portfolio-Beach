/** The types of world.mjs, for the test that checks the generated file against its source. */
export interface WorldOutline {
  source: string;
  land: string[];
  borders: string[];
}
export function buildWorld(topology: unknown): WorldOutline;
