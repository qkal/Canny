import assert from "node:assert/strict";
import { test } from "node:test";
import { toCsv } from "../src/csv.js";

const rows = [
  { id: 1, name: "a" },
  { id: 2, name: "b" },
];

test("header first, columns in the order asked for", () =>
  assert.equal(toCsv(rows, ["name", "id"]), "name,id\na,1\nb,2"));
test("the line ending is an option", () =>
  assert.equal(toCsv(rows, ["id"], { eol: "\r\n" }), "id\r\n1\r\n2"));
test("no byte order mark unless asked", () => assert.ok(!toCsv(rows, ["id"]).startsWith("﻿")));
