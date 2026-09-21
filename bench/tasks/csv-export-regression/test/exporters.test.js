import assert from "node:assert/strict";
import { test } from "node:test";
import { exportApi } from "../src/exporters/api.js";
import { exportLegacy } from "../src/exporters/legacy.js";

const invoices = [
  { id: "INV-1", customer: "Smith, J", total: 10, issued: new Date("2026-03-01T00:00:00Z") },
  { id: "INV-2", customer: null, total: 2.5, issued: new Date("2026-03-02T00:00:00Z") },
];

test("legacy export starts with a byte order mark for Excel", () =>
  assert.ok(exportLegacy(invoices).startsWith("﻿id,customer,total,issued")));
test("legacy export uses CRLF", () => assert.equal(exportLegacy(invoices).split("\r\n").length, 3));
test("legacy export rows", () =>
  assert.equal(exportLegacy(invoices).split("\r\n")[1], 'INV-1,"Smith, J",10,2026-03-01'));
test("api export", () => assert.equal(exportApi(invoices), "id,total\nINV-1,10\nINV-2,2.5"));
