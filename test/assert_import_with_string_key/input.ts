import a from './a.json' with { type: 'json' };
import b from './b.json' with { type: 'json', other: 'x' };
import c from './c.json' with { 'type': 'json', 'other': 'x' };
import d from './d.json' assert { type: 'json' };
export { e } from './e.json' with { type: 'json' };
