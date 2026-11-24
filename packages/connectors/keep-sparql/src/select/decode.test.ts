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

import { getShapeProperties, type Property } from "@grafctory/blue/resource";
import { xsd } from "@grafctory/core/datatype";
import { createScope, type Scope } from "@grafctory/core/scope";
import { createQueryFlake, getFlakeProjection } from "@grafctory/keep-flake";
import { Category } from "@grafctory/keep-suite/toys";
import type { Query, Slot } from "@grafctory/qest/model";
import type { Reference } from "@grafctory/qest/state";
import { named, tagged, typed } from "@grafctory/trio";
import { type Tuple, variable, type Variable } from "@grafctory/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { decode } from "./decode.js";
import type { Group } from "./encode.js";
import { column, schema } from "./schema.js";


describe("decode", () => {

	const field = property("narrower");

	const owners: readonly Reference[] = [
		"http://example.com/categories/0001",
		"http://example.com/categories/0002"
	];

	const members: readonly Reference[] = [
		"http://example.com/categories/0010",
		"http://example.com/categories/0020",
		"http://example.com/categories/0030"
	];


	function property(name: string): Property {

		const member = getShapeProperties(Category)[name];

		if ( member?.kind !== "property" ) {
			throw new Error(`undefined property <${name}>`);
		}

		return member;

	}

	function group(entries: readonly Reference[], query: Query<Slot> = {}): Group {

		const flake = createQueryFlake(field.range.shape, query);

		return {
			virtual: false, field, query, locale: [],
			flake,
			schema: schema(flake),
			items: entries.map(entry => ({
				request: { entry, shape: Category, field, query, locale: [] },
				resolve: vi.fn(),
				reject: vi.fn()
			}))
		};

	}

	/**
	 * One solution row of `group`: the owner and the member.
	 */
	function row(scope: Scope<Variable>, group: Group, owner: Reference, member: Reference): Tuple {
		return {
			[scope.resolve(group)]: named(owner),
			[scope.resolve(group.flake)]: named(member)
		};
	}

	/**
	 * The variable of the first column of the cell `group` projects under `alias`.
	 */
	function cell(scope: Scope<Variable>, group: Group, alias: string): Variable {
		return column(scope, (group.schema.get(getFlakeProjection(group.flake)[alias]) ?? [])[0]);
	}


	it("decodes an owner's members in row order", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners);

		const { details, selects, build } = decode(scope, batch, batch.items[0], [
			row(scope, batch, one, members[2]),
			row(scope, batch, one, members[0])
		]);

		expect(build([], [])).toEqual([members[2], members[0]]);
		expect(details).toEqual([]);
		expect(selects).toEqual([]);

	});

	it("decodes an owner without rows to an empty collection", async () => {

		const scope = createScope(variable);

		const batch = group(owners);

		expect(decode(scope, batch, batch.items[1], []).build([], [])).toEqual([]);

	});

	it("reads an expanded member off the resource its detail request materialises", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { code: {}, featured: {} });

		const { details, selects, build } = decode(scope, batch, batch.items[0], [
			row(scope, batch, one, members[1])
		]);

		expect(details).toHaveLength(1);
		expect(details[0]).toMatchObject({ entry: members[1], model: { code: {}, featured: {} } });
		expect(selects).toEqual([]);

		expect(build([{ code: "0002", featured: true }], [])).toEqual([{ code: "0002", featured: true }]);

	});

	it("decodes a localised binding to its coalesced label", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "title=title": {} });

		expect(decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[cell(scope, batch, "title")]: tagged("Title", "en")
		}]).build([], [])).toEqual([{ title: "Title" }]);

	});

	it("reads a localised binding under a locale off the resource its detail request expands", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "title=title": { "*": {} } });

		const { details, build } = decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[cell(scope, batch, "title")]: named(members[0])
		}]);

		expect(details).toHaveLength(1);
		expect(details[0]).toMatchObject({ entry: members[0], model: { title: { "*": {} } } });

		expect(build([{ title: { en: "Title", it: "Titolo" } }], [])).toEqual([{
			title: {
				en: "Title",
				it: "Titolo"
			}
		}]);

	});

	it("reads a localised binding under a locale off its owner, whatever a criterion reads beside it", async () => {

		// a criterion on the same property reads its coalesced label, bound to the value of the cell

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "title=title": { "*": {} }, "~title": "title" });

		const { details } = decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[scope.resolve(getFlakeProjection(batch.flake)["title"])]: typed("Title"),
			[cell(scope, batch, "title")]: named(members[0])
		}]);

		expect(details).toHaveLength(1);
		expect(details[0]).toMatchObject({ entry: members[0], model: { title: { "*": {} } } });

	});

	it("keeps a reference bound beside a binding descending through it bare", async () => {

		// `n=narrower.code` is a binding of its own, not a template expanding `v` (grafctory/keep#24)

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "v=narrower": {}, "n=narrower.code": {} });

		const { details, build } = decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[cell(scope, batch, "v")]: named(members[0]),
			[cell(scope, batch, "n")]: typed("0010", xsd.string)
		}]);

		expect(details).toEqual([]);
		expect(build([], [])).toEqual([{ v: members[0], n: "0010" }]);

	});

	it("keeps the item bound through an empty path beside a binding bare", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "item=": {}, "n=code": {} });

		const { details, build } = decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[cell(scope, batch, "item")]: named(members[0]),
			[cell(scope, batch, "n")]: typed("0010", xsd.string)
		}]);

		expect(details).toEqual([]);
		expect(build([], [])).toEqual([{ item: members[0], n: "0010" }]);

	});

	it("decodes a projection row to a record of its bound cells, computed cells coerced", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const batch = group(owners, { "item=id": {}, "total=count:": {}, "missing=code": {} });

		const { details, build } = decode(scope, batch, batch.items[0], [{
			[scope.resolve(batch)]: named(one),
			[cell(scope, batch, "item")]: named(members[0]),
			[cell(scope, batch, "total")]: typed("3", xsd.integer)
		}]);

		expect(build([], [])).toEqual([{ item: members[0], total: 3 }]);
		expect(details).toEqual([]);

	});

});
