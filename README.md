# @grafctory/keep

[![npm](https://img.shields.io/npm/v/@grafctory/keep)](https://www.npmjs.com/package/@grafctory/keep)

Turnkey model-driven storage for linked data resources.

**@grafctory/keep** stores and retrieves linked data resources independently of the backend holding them, driven by the
resource models that describe them:

- **Model-Driven Storage**: data models defined with [@grafctory/blue](https://github.com/grafctory/blue) drive storage
	and validation
- **Declarative Operations**: CRUD operations on linked data resources without handwritten queries
- **Pluggable Connectors**: one storage API over every supported backend, through interchangeable connector packages

| Layer      | Package                                                 | Description                       |
|------------|---------------------------------------------------------|-----------------------------------|
| Components | [@grafctory/keep]                                        | Core model-driven storage API     |
|            | [@grafctory/keep-flake]                                  | Shape-driven traversal trees      |
|            | [@grafctory/keep-suite]                                  | Connector conformance test suite  |
| Connectors | [@grafctory/keep-rest]                                   | REST/JSON proxy connector         |
|            | [*upcoming*](https://github.com/grafctory/keep/issues/1) | [SQL:2011] database connector     |
|            | [*upcoming*](https://github.com/grafctory/keep/issues/2) | [GQL:2024] graph connector        |
|            | [@grafctory/keep-sparql]                                 | [SPARQL 1.1] repository connector |

[@grafctory/keep]: https://grafctory.github.io/keep/modules/_grafctory_keep.html

[@grafctory/keep-flake]: https://grafctory.github.io/keep/modules/_grafctory_keep-flake.html

[@grafctory/keep-suite]: https://grafctory.github.io/keep/modules/_grafctory_keep-suite.html

[@grafctory/keep-sparql]: https://grafctory.github.io/keep/modules/_grafctory_keep-sparql.html

[@grafctory/keep-rest]: https://grafctory.github.io/keep/modules/_grafctory_keep-rest.html

[SQL:2011]: https://www.iso.org/standard/53681.html

[GQL:2024]: https://www.iso.org/standard/76120.html

[SPARQL 1.1]: https://www.w3.org/TR/sparql11-overview/


# Installation

Pick the connector for your backend from the table above and install it. The connector pulls in the framework packages
it needs, so you don't install them yourself.

Some connectors also need a separate backend library, such as a driver, runtime or client. The connector README lists
any such requirement.

```shell
npm install @grafctory/keep-<connector>    # connector from the table above
npm install <backend-package>             # backend library, if the connector requires one
```

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.


# Usage

> [!NOTE]
>
> Each package documents its own API in its README and API reference; for complete coverage, see the
> [API reference](https://grafctory.github.io/keep/).

An application obtains a store from a backend connector, then reads and writes resources against the models describing
them, whatever the backend. For example, with the SPARQL connector over an RDF4J Server repository:

```ts
import { createSPARQLStore } from "@grafctory/keep-sparql";
import { createRDF4JRepository } from "@grafctory/wire-sparql-rdf4j";

const store = createSPARQLStore(createRDF4JRepository({
	server: "http://localhost:8080/rdf4j-server",
	repository: "products"
}));

const product = await store.lookup({
	entry: "http://example.com/products/1",
	shape: ProductShape,
	model: {
		name: {},
		price: {},
		vendor: { id: {}, name: {} }
	}
});
```

# Support

- open an [issue](https://github.com/grafctory/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/grafctory/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/grafctory/keep?tab=Apache-2.0-1-ov-file) file for details.
