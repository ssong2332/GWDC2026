import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

describe("integration test harness smoke", () => {
    let db: Database.Database | undefined;

    afterEach(() => {
        db?.close();
        db = undefined;
    });

    it("loads the better-sqlite3 native binding and round-trips a row", () => {
        db = new Database(":memory:");
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
        db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");

        expect(db.prepare("SELECT id, v FROM t").all()).toEqual([{ id: 1, v: "ok" }]);
    });
});
