/*
 * Copyright © 2025-2026 Metreeca srl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getShapeProperties, type Property } from "@metreeca/blue/resource";
import type { Tag } from "@metreeca/core/language";
import { createScope } from "@metreeca/core/scope";
import { createQueryFlake } from "@metreeca/keep-flake";
import { Category, toys, Vendors } from "@metreeca/keep-suite/toys";
import type { Select } from "@metreeca/keep/batching";
import type { Query, Slot } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { type SPARQL, variable } from "@metreeca/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { encode, type Group } from "./encode.js";
import { schema } from "./schema.js";


describe("encode", () => {

	const narrower = property(Category, "narrower");
	const members = property(Vendors, "members");

	const entries: readonly Reference[] = [
		"http://example.com/categories/0001",
		"http://example.com/categories/0002",
		"http://example.com/categories/0003"
	];


	function property(shape: Select["shape"], name: string): Property {

		const member = getShapeProperties(shape)[name];

		if ( member?.kind !== "property" ) {
			throw new Error(`undefined property <${name}>`);
		}

		return member;

	}

	function plan(
		shape: Select["shape"],
		field: Property,
		entries: readonly Reference[],
		query: Query<Slot>,
		locale: readonly Tag[],
		virtual: boolean
	): Group {

		const flake = createQueryFlake(field.range.shape, query);

		return {
			virtual, field, query, locale,
			flake,
			schema: schema(flake),
			items: entries.map(entry => ({
				request: { virtual, entry, shape, field, query, locale },
				resolve: vi.fn(),
				reject: vi.fn()
			}))
		};

	}

	/**
	 * The group of the categories narrower than each of `entries`.
	 */
	function group(entries: readonly Reference[], query: Query<Slot> = {}, locale: readonly Tag[] = [], virtual: boolean = false): Group {
		return plan(Category, narrower, entries, query, locale, virtual);
	}

	/**
	 * The group of the vendors listed under each entry, whose union-typed properties the categories lack.
	 */
	function vendors(query: Query<Slot>, locale: readonly Tag[] = []): Group {
		return plan(Vendors, members, entries, query, locale, false);
	}

	function query(group: Group): SPARQL {
		return encode(createScope(variable), group);
	}

	function bindings(query: SPARQL): readonly string[] {
		return query.match(/values \(\?\d+\) \{[^}]*}/g) ?? [];
	}


	describe("with the owners", () => {

		it("binds every owner in one block", async () => {

			const encoded = query(group(entries));

			expect(bindings(encoded)).toHaveLength(1);
			expect(encoded).not.toContain(" union ");

			entries.forEach(entry => expect(encoded).toContain(`(<${entry}>)`));

		});

		it("binds each owner of a sliced query in an arm of its own", async () => {

			const encoded = query(group(entries, { "@": 1, "#": 1 }));

			expect(bindings(encoded)).toHaveLength(entries.length);
			expect(encoded.match(/ union /g)).toHaveLength(entries.length-1);

			bindings(encoded).forEach((binding, index) => expect(binding).toContain(`(<${entries[index]}>)`));

		});

		it("projects the owner first and orders by it first", async () => {

			const encoded = query(group(entries));

			const owner = encoded.match(/values \((\?\d+)\)/)?.[1];

			expect(encoded).toContain(`select distinct ${owner} `);
			expect(encoded).toContain(`order by asc(${owner}) `);

		});

		it("groups aggregates by the owner", async () => {

			const encoded = query(group(entries, { "total=count:id": {} }));

			const owner = encoded.match(/values \((\?\d+)\)/)?.[1];

			expect(encoded).toContain(`group by ${owner}`);

		});

	});

	describe("with the reductions", () => {

		// a subselect per reduced value, its rows required to carry the value, keeps a member lacking it
		// out of the aggregates (Appendix A.4.2), which an unbound input would void on a backend reading
		// SPARQL 1.1 §18.5.1 strictly; the subselects stand out as the only nested `select` clauses

		function subselects(query: SPARQL): readonly string[] {
			return query.match(/\{ select /g) ?? [];
		}

		function joins(query: SPARQL): readonly string[] {
			return query.match(/bind\(coalesce\(\?\d+, <[^>]+>\) as \?\d+\)/g) ?? [];
		}

		function requirements(query: SPARQL): readonly string[] {
			return query.match(/filter\(bound\(\?\d+\)\)/g) ?? [];
		}

		function grouped(query: SPARQL): readonly string[] {
			return (query.match(/group by (?:\?\d+ ?)+/g) ?? []).map(clause => clause.match(/\?\d+/g) ?? []).sort((x, y) => y.length-x.length)[0] ?? [];
		}


		it("reduces each value in a subselect requiring it", async () => {

			const encoded = query(group(entries, { "low=min:code": {}, "cnt=count:broader": {} }));

			expect(subselects(encoded)).toHaveLength(2);
			expect(requirements(encoded)).toHaveLength(2);

		});

		it("shares the subselect of reductions over the same value", async () => {

			const encoded = query(group(entries, { "low=min:code": {}, "high=max:code": {} }));

			expect(subselects(encoded)).toHaveLength(1);
			expect(encoded.match(/min\(/g)).toHaveLength(1);
			expect(encoded.match(/max\(/g)).toHaveLength(1);

		});

		it("groups by the owner, the keys and the reduced columns", async () => {

			const encoded = query(group(entries, { "code=code": {}, "cnt=count:broader": {}, "low=min:featured": {} }));

			// the owner, the key and the two reduced columns, the reductions being settled in their subselects

			expect(grouped(encoded)).toHaveLength(4);

		});

		it("restores the zero of count and sum over an empty group", async () => {

			const encoded = query(group(entries, { "cnt=count:broader": {}, "low=min:code": {} }));

			expect(encoded.match(/coalesce\(\?\d+, 0\)/g)).toHaveLength(1);

		});

		it("joins a reduction to its group by its keys, an absent key included", async () => {

			const encoded = query(group(entries, { "upper=upper": {}, "cnt=count:broader": {} }));

			// the key is bound to a join variable standing in for an absent key, once in the query and once in
			// the subselect, so neither side ever matches an unbound key with any value of the other side

			expect(joins(encoded)).toHaveLength(2);

		});

		it.each<[string, Query<Slot>]>([
			["a plain query", {}],
			["a sorted query", { "^code": 1 }],
			["a projection", { "code=code": {} }]
		])("joins nothing in %s reducing nothing", async (_, request) => {

			// with no subselect to join, the join variables have no use

			expect(joins(query(group(entries, request)))).toHaveLength(0);

		});

		it("binds the owners of the requests in every subselect", async () => {

			const encoded = query(group(entries, { "cnt=count:broader": {}, "low=min:code": {} }));

			expect(bindings(encoded)).toHaveLength(3);

		});

		it("never feeds the surviving owner row to an aggregate", async () => {

			const encoded = query(group(entries, { "cnt=count:broader": {} }));

			expect(encoded).not.toContain("if(bound(");

		});

		describe("over a union-typed value", () => {

			// `Vendor.score` is `union(decimal, string)`: `sum`/`avg` accept its number variant alone, `min`/`max`
			// and `count` accept both, so only the former need the subselect to guard the branch (Appendix A.4.2)

			function guards(query: SPARQL): readonly string[] {
				return query.match(/filter\(\(bound\(\?\d+\) && isnumeric\(\?\d+\)\)\)/g) ?? [];
			}


			it("guards the variants a reduction accepts", async () => {

				const encoded = query(vendors({ "total=sum:score": {}, "mean=avg:score": {} }));

				expect(subselects(encoded)).toHaveLength(1);
				expect(guards(encoded)).toHaveLength(1);
				expect(requirements(encoded)).toHaveLength(0);

			});

			it("requires the value alone where a reduction accepts every variant", async () => {

				const encoded = query(vendors({ "cnt=count:score": {}, "low=min:score": {} }));

				expect(subselects(encoded)).toHaveLength(1);
				expect(guards(encoded)).toHaveLength(0);
				expect(requirements(encoded)).toHaveLength(1);

			});

			it("guards the coalesced text of a union mixing it with a resource", async () => {

				// `Vendor.origin` is `union(dictionary, Place)`: `min` accepts the text alone, which reaches the
				// reduction coalesced to a plain string (§6.2), so the guard is the plain string test

				const encoded = query(vendors({ "least=min:origin": {} }));

				expect(subselects(encoded)).toHaveLength(1);
				expect(encoded.match(/filter\(\(bound\(\?\d+\) && \(isliteral\(\?\d+\) && lang\(\?\d+\) = ""/g)).toHaveLength(1);
				expect(requirements(encoded)).toHaveLength(0);

			});

			it("keeps apart the subselects of reductions accepting different variants", async () => {

				const encoded = query(vendors({ "total=sum:score": {}, "low=min:score": {} }));

				expect(subselects(encoded)).toHaveLength(2);
				expect(guards(encoded)).toHaveLength(1);
				expect(requirements(encoded)).toHaveLength(1);

			});

		});

	});

	describe("with a virtual collection", () => {

		// the member class the range declares, which a held query never states and a virtual one binds
		// the members by, in place of the edge off the owner, so its IRI tells the two query forms apart

		const clazz = `<${toys.Category}>`;

		it("binds the members by the class of the range rather than by the owner edge", async () => {

			const encoded = query(group(entries, {}, [], true));

			expect(encoded).toContain(clazz);
			expect(bindings(encoded)).toHaveLength(1);

			entries.forEach(entry => expect(encoded).toContain(`(<${entry}>)`));

		});

		it("binds the members of a held collection by the owner edge alone", async () => {

			expect(query(group(entries))).not.toContain(clazz);

		});

	});

	describe("with the sort keys", () => {

		// a key is ranked by processing type before its value (§5.7.5): its types are told apart row by row
		// only where the range of the key admits values of several of them, and not at all otherwise

		const typed = "datatype(";
		const numeric = "isnumeric(";

		function ordering(query: SPARQL): string {
			return query.slice(query.lastIndexOf("order by"));
		}


		it.each<[string, () => Group]>([
			["a string key", () => group(entries, { "^code": 1 })],
			["a boolean key", () => group(entries, { "^featured": 1 })],
			["a localised key", () => group(entries, { "^label": 1 }, ["en"])]
		])("orders %s by its value alone", async (_, request) => {

			const ordered = ordering(query(request()));

			expect(ordered).not.toContain(typed);
			expect(ordered).not.toContain(numeric);

		});

		it("tells apart only the numeric type of a union key admitting numbers and strings", async () => {

			// `Vendor.score` is `union(decimal, string)`: a number or a string, never a boolean or a temporal value

			const ordered = ordering(query(vendors({ "^score": 1 })));

			expect(ordered).toContain(numeric);
			expect(ordered).not.toContain(typed);

		});

		it("tells apart only the datatypes of a union key admitting booleans and dates", async () => {

			// `Vendor.audited` is `union(boolean, date)`: a boolean or a temporal value, never a number

			const ordered = ordering(query(vendors({ "^audited": 1 })));

			expect(ordered).toContain(typed);
			expect(ordered).not.toContain(numeric);

		});

		it("tells apart every type for a key admitting a node", async () => {

			// `Vendor.origin` is `union(dictionary, Place)`: a node has no processing type to be ranked by

			const ordered = ordering(query(vendors({ "^origin": 1 }, ["en"])));

			expect(ordered).toContain(typed);
			expect(ordered).toContain(numeric);

		});

	});

	describe("with the window", () => {

		it("keeps the server window for a single owner", async () => {

			const encoded = query(group(entries.slice(0, 1), { "@": 1, "#": 2 }));

			expect(encoded).toContain("offset 1");
			expect(encoded).toContain("limit 2");

		});

		it("windows every owner's arm on the server", async () => {

			const encoded = query(group(entries, { "@": 1, "#": 2 }));

			expect(encoded.match(/offset 1 limit 2/g)).toHaveLength(entries.length);

		});

	});

	describe("with the variant columns", () => {

		// `Vendor.score` is `union(decimal, string)`: retrieved as a union, it binds one arm per variant beside
		// its edge (§5.5), each restating the edge, so the edges of a query count the arms it binds

		function edges(query: SPARQL): number {
			return query.split(`<${toys.score}>`).length-1;
		}


		it("binds the arms of a cell it returns", async () => {

			const encoded = query(vendors({ "score=score": {} }));

			expect(edges(encoded)).toBe(3);

		});

		it("binds the arms of a key it groups by, in the query and in every subselect", async () => {

			const encoded = query(vendors({ "score=score": {}, "cnt=count:id": {} }));

			expect(edges(encoded)).toBe(6);

		});

		it("binds no arm for a value it only orders by", async () => {

			// the detail pass re-fetches the templated content and the ordering reads the value off its edge

			const encoded = query(vendors({ score: {}, "^score": 1 }));

			expect(edges(encoded)).toBe(1);

		});

		it("binds no arm for a value it only orders by in the arms of a sliced query", async () => {

			const encoded = query(vendors({ score: {}, "^score": 1, "#": 1 }));

			expect(edges(encoded)).toBe(entries.length);

		});

	});

	describe("with text mixed with other variants", () => {

		// a folded value (§3.2) is told from text by its language tag, which a node does not have: reading the
		// tag of a node is an error, so it takes a guard only where the range admits a node

		const guard = "coalesce(lang(";

		it("reads the language tag unguarded where no variant holds a node", async () => {

			// `Vendor.tagline` is `union(string, dictionary)`

			const encoded = query(vendors({ "^tagline": 1 }, ["en"]));

			expect(encoded).toContain("lang(");
			expect(encoded).not.toContain(guard);

		});

		it("guards the language tag where a variant holds a node", async () => {

			// `Vendor.origin` is `union(dictionary, Place)`

			const encoded = query(vendors({ "^origin": 1 }, ["en"]));

			expect(encoded).toContain(guard);

		});

	});

	describe("with the language priority", () => {

		// a text value passes under the first priority tag its owner carries a value under (§6.2): a tag is
		// settled by probing the owner for the tags ahead of it alone, so the leading tag takes no probe

		function probes(query: SPARQL, tag?: Tag): readonly string[] {
			return (query.match(/exists \{[^}]*}/g) ?? [])
				.filter(probe => tag === undefined || probe.includes(`"${tag}"`));
		}


		it.each<[string, () => Group]>([
			["localised text", () => group(entries, { "^label": 1 }, ["en"])],

			// `Vendor.origin` is `union(dictionary, Place)`, so its values reach the query folded (§3.2)

			["text mixed with other variants", () => vendors({ "^origin": 1 }, ["en"])]
		])("probes nothing for %s under a single tag", async (_, request) => {

			const encoded = query(request());

			expect(encoded).toContain(`"en"`);
			expect(probes(encoded)).toHaveLength(0);

		});

		it("probes the owner for the tags ahead of each tag alone", async () => {

			const encoded = query(group(entries, { "^label": 1 }, ["en", "it", "fr"]));

			// `it` yields to `en`, `fr` to `en` and `it`, and nothing yields to `fr`

			expect(probes(encoded, "en")).toHaveLength(2);
			expect(probes(encoded, "it")).toHaveLength(1);
			expect(probes(encoded, "fr")).toHaveLength(0);

		});

		it("probes nothing under an empty priority", async () => {

			const encoded = query(group(entries, { "^label": 1 }, []));

			expect(probes(encoded)).toHaveLength(0);

		});

	});

});
