import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { javaExecutable, javaTooOldMessage, parseJavaVersion } from "./java.js";

test("the server's java is JAVA_HOME's when set, otherwise the one on PATH", () => {
  const name = process.platform === "win32" ? "javaw.exe" : "java";
  assert.equal(javaExecutable({}), name);
  assert.equal(javaExecutable({ JAVA_HOME: "/opt/jdk-21" }), join("/opt/jdk-21", "bin", name));
});

test("java -version is read in both the modern and the pre-9 spelling", () => {
  assert.deepEqual(parseJavaVersion('openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment'), { version: "17.0.12", major: 17 });
  assert.deepEqual(parseJavaVersion('openjdk version "21" 2023-09-19'), { version: "21", major: 21 });
  assert.deepEqual(parseJavaVersion('openjdk version "22-ea" 2024-03-19'), { version: "22-ea", major: 22 });
  assert.deepEqual(parseJavaVersion('java version "1.8.0_392"'), { version: "1.8.0_392", major: 8 });
  assert.equal(parseJavaVersion("bash: java: command not found"), undefined);
});

test("a server refused by an old Java names the Java it needs and how to select it", () => {
  // What Minecraft 1.21.4's bundler prints under Java 17.
  const refusal = "Error: LinkageError occurred while loading main class net.minecraft.bundler.Main\n"
    + "\tjava.lang.UnsupportedClassVersionError: net/minecraft/bundler/Main has been compiled by a more recent version "
    + "of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0";
  const message = javaTooOldMessage(refusal, "java", "1.21.4");
  assert.match(message ?? "", /^Minecraft 1\.21\.4 needs Java 21 or newer, but java is Java 17\. /u);
  assert.match(message ?? "", /set JAVA_HOME/u);
  assert.equal(javaTooOldMessage("[Server thread/INFO]: Done (3.1s)!", "java", "1.21.4"), undefined);
});
