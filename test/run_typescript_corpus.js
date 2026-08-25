import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';
import { tsPlugin } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.join(__dirname, '..');

const corpus_root = process.env.TS_CORPUS ?? path.join(repo_root, 'corpus', 'typescript');
const cases_dir = path.join(corpus_root, 'tsc', 'testdata', 'tests', 'cases');
const baseline_path = path.join(__dirname, 'typescript_corpus_baseline.txt');

const SUITES = ['compiler', 'conformance'];

const PARSEABLE = /\.(m|c)?(ts|tsx|js|jsx)$/;

const DIRECTIVE = /^\s*\/\/\s*@\w+\s*:/;

const args = process.argv.slice(2);
const update = args.includes('--update');
const list_new = args.includes('--list-new');
const filter = (() => {
	const i = args.indexOf('--filter');
	return i === -1 ? null : args[i + 1];
})();

const TsParser = acorn.Parser.extend(tsPlugin());
const DtsParser = acorn.Parser.extend(tsPlugin({ dts: true }));
const JsxParser = acorn.Parser.extend(tsPlugin({ jsx: true }));

function parser_for(filename) {
	if (/\.d\.(m|c)?ts$/.test(filename)) return DtsParser;
	if (/\.(m|c)?jsx?$/.test(filename) || /\.tsx$/.test(filename)) return JsxParser;
	return TsParser;
}

function read_source(file) {
	const buffer = fs.readFileSync(file);

	if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
	if (buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.swap16().toString('utf16le', 2);

	return buffer.toString('utf8').replace(/^﻿/, '');
}

function split_units(rel_path, source) {
	const units = [];
	let current = null;

	source.split(/\r?\n/).forEach((line, index) => {
		const match = /^\s*\/\/\s*@filename\s*:\s*(.+?)\s*$/i.exec(line);

		if (match) {
			current = { name: match[1], first_line: index + 2, lines: [] };
			units.push(current);
			return;
		}

		if (current === null) {
			current = { name: path.basename(rel_path), first_line: index + 1, lines: [] };
			units.push(current);
		}

		current.lines.push(line);
	});

	return units
		.filter((unit) => PARSEABLE.test(unit.name))
		.map((unit) => {
			let start = 0;
			while (
				start < unit.lines.length &&
				(unit.lines[start].trim() === '' || DIRECTIVE.test(unit.lines[start]))
			) {
				start++;
			}

			return {
				name: unit.name,
				code: unit.lines.slice(start).join('\n'),
				line_offset: unit.first_line + start - 1,
				multi: units.length > 1
			};
		})
		.filter((unit) => unit.code.trim() !== '')
		.map((unit) => ({
			...unit,
			id: unit.multi ? `${rel_path}::${unit.name}` : rel_path
		}));
}

function parse_unit(unit) {
	const Parser = parser_for(unit.name);
	let module_error;

	for (const sourceType of ['module', 'script']) {
		try {
			Parser.parse(unit.code, {
				sourceType,
				ecmaVersion: 'latest',
				allowHashBang: true,
				locations: true
			});
			return null;
		} catch (e) {
			if (sourceType === 'module') module_error = e;
			if (!(e instanceof SyntaxError)) return `${e.constructor.name}: ${e.message}`;
		}
	}

	return module_error.message.replace(/\((\d+):(\d+)\)/, (_, line, column) => {
		return `(${Number(line) + unit.line_offset}:${column})`;
	});
}

function walk(dir, rel) {
	const out = [];

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const child_rel = `${rel}/${entry.name}`;

		if (entry.isDirectory()) {
			out.push(...walk(path.join(dir, entry.name), child_rel));
		} else if (PARSEABLE.test(entry.name)) {
			out.push(child_rel);
		}
	}

	return out;
}

if (!fs.existsSync(cases_dir)) {
	console.error(`TypeScript corpus not found at ${cases_dir}`);
	console.error('Run `pnpm corpus:setup` to fetch it.');
	process.exit(1);
}

const failures = new Map();
let total_units = 0;
let total_files = 0;

for (const suite of SUITES) {
	const suite_dir = path.join(cases_dir, suite);
	if (!fs.existsSync(suite_dir)) continue;

	for (const rel of walk(suite_dir, suite).sort()) {
		if (filter && !rel.includes(filter)) continue;

		total_files++;

		for (const unit of split_units(rel, read_source(path.join(cases_dir, rel)))) {
			total_units++;
			const error = parse_unit(unit);
			if (error !== null) failures.set(unit.id, error.replace(/\s+/g, ' ').trim());
		}
	}
}

const sorted = [...failures.keys()].sort();
const rate = total_units === 0 ? 0 : (failures.size / total_units) * 100;

if (update) {
	fs.writeFileSync(
		baseline_path,
		[
			'# Parse failures over the TypeScript compiler test corpus.',
			'# Regenerate with `pnpm test:typescript:update`.',
			'#',
			'# Many entries here are correct: the corpus deliberately includes invalid',
			'# syntax to pin down compiler error messages. This file exists to catch',
			'# *changes*, not to assert that everything listed ought to parse.',
			`# units: ${total_units}  failing: ${failures.size} (${rate.toFixed(2)}%)`,
			'',
			...sorted.map((id) => `${id}\t${failures.get(id)}`),
			''
		].join('\n')
	);

	console.log(
		`Wrote ${path.relative(repo_root, baseline_path)}: ` +
			`${failures.size} failing of ${total_units} units in ${total_files} files.`
	);
	process.exit(0);
}

if (!fs.existsSync(baseline_path)) {
	console.error(`No baseline at ${path.relative(repo_root, baseline_path)}.`);
	console.error('Run `pnpm test:typescript:update` to create it.');
	process.exit(1);
}

const baseline = new Map(
	fs
		.readFileSync(baseline_path, 'utf-8')
		.split('\n')
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const tab = line.indexOf('\t');
			return [line.slice(0, tab), line.slice(tab + 1)];
		})
);

const added = sorted.filter((id) => !baseline.has(id));
const removed = [...baseline.keys()].filter((id) => !failures.has(id));
const changed = sorted.filter((id) => baseline.has(id) && baseline.get(id) !== failures.get(id));

console.log(
	`${total_units} units in ${total_files} files; ${failures.size} failing (${rate.toFixed(2)}%).`
);

if (filter) {
	console.log(`(--filter ${filter}: only matched units were run)`);
}

for (const id of removed) console.log(`  fixed:   ${id}`);

for (const id of changed) {
	console.log(`  changed: ${id}`);
	console.log(`    was: ${baseline.get(id)}`);
	console.log(`    now: ${failures.get(id)}`);
}

const shown = list_new ? added : added.slice(0, 25);
for (const id of shown) console.log(`  NEW:     ${id}\t${failures.get(id)}`);
if (added.length > shown.length) {
	console.log(`  ... and ${added.length - shown.length} more (pass --list-new for all)`);
}

if (added.length > 0 || changed.length > 0) {
	console.error(
		`\n${added.length} new and ${changed.length} changed parse failures. ` +
			'If these are expected, run `pnpm test:typescript:update`.'
	);
	process.exit(1);
}

if (removed.length > 0 && !filter) {
	console.error(
		`\n${removed.length} baseline entries now parse. ` +
			'Run `pnpm test:typescript:update` to record the improvement.'
	);
	process.exit(1);
}

console.log('No change against baseline.');
