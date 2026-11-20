# Java 字节码代码图 —— 设计 / 规格文档

> 目标读者:在**新文件夹/新项目**里实现"让 AI agent 能分析 JAR/.class 编译产物"的人。
> 本文件自包含,可直接拷到新项目作为规格。最终架构经多轮收敛后**故意做薄**。

---

## 1. 目标与范围

给 AI agent 一种能力:对**没有源码的 Java 编译产物(JAR / WAR / .class)**做——
- 结构理解(类 / 方法 / 字段 / 继承 / 接口)
- 调用关系(谁调用 X / X 调用谁)
- 调用链 / gadget chain(source → sink 的可达路径)
- 攻击面(Spring 路由、Servlet/Filter、硬编码字符串、Serializable 类)
- 反编译某个类

**v1 范围**:只处理字节码(不处理 Java 源码)。安全审计向(找链/反序列化)是主要场景。

---

## 2. 架构:两个彻底解耦的部分

```
【Part 1 · 数据库生成器】 = 一个独立程序(偶尔跑一次,需要 Java)
   jar-analyzer-engine (MIT, Java 8, ASM)
   java -jar jar-analyzer-engine.jar --jar 目标.jar  →  jar-analyzer.db (SQLite, 14 张表)
                         │
                         ▼  契约 = 这张库的 schema(见 §4)
【Part 2 · agent 查询工具】 = 只读那张库(查询时不需要 Java)
   node:sqlite 打开 .db → 封装少量工具:
     analyze_jar / jar_callers / jar_callees / jar_find_chains /
     jar_impact / jar_find_strings / jar_list_routes / jar_search / jar_decompile
```

**为什么这样分:**
1. **运行时无 Java 依赖**——agent 查询纯 `node:sqlite`;只有"生成/刷新数据库"那一刻才起 java。
2. **可替换**——以后想换提取器、加 tabby(Soot 污点)、改 schema,只动 Part 1;Part 2 只认那张库。
3. **不需要 CodeGraph / GitNexus**——它们的价值层(tree-sitter 解析 + 跨文件 resolution)是给**源码**的;字节码的 `invoke*` 指令已是全限定 `owner+name+desc`,几乎不需要 resolution。"查图"对我们就是几条 SQL + 一个递归 CTE。
4. **关系型比属性图更省**——jar-analyzer 的 `method_call_table` 直接把 callee 存成字符串,调用到 JDK 方法(如 `java/lang/Runtime.exec`)本来就是一行记录,**无需"外部节点"建模**。

---

## 3. Part 1 —— 数据库生成器(直接用现成 MIT 引擎)

- 项目:`jar-analyzer-engine`(作者 4ra1n / n1ar4),**MIT 许可**,Java 8,基于 **ASM**;反编译用 **FernFlower**。
- 它是 `jar-analyzer`(完整版,GPLv3)抽出来的**纯无头 CLI 引擎**——**只用这个 MIT 引擎,不要 GPLv3 的完整版**。

**构建(一次性 / CI):**
```bash
cd jar-analyzer-engine
mvn clean package -DskipTests
# 产物(fat jar): target/jar-analyzer-engine-<ver>-jar-with-dependencies.jar
# Main-Class: me.n1ar4.jar.analyzer.EngineMain
```

**生成数据库:**
```bash
java -jar jar-analyzer-engine.jar --jar 目标.jar          # 标准分析
java -jar jar-analyzer-engine.jar --jar app.jar --fix-class --inner-jars   # Spring Boot 推荐
java -jar jar-analyzer-engine.jar --jar app.jar --quick   # 仅调用关系(快;impl/string/spring/web 表为空)
java -jar jar-analyzer-engine.jar --jar /path/to/lib/     # 分析整个目录
# 输出: 当前工作目录下 jar-analyzer.db
```
常用参数:`--jar/-j`(必填,jar 或目录)、`--quick/-q`、`--fix-class`、`--inner-jars`、
`--white-list/-w`、`--black-list/-b`、`--rt`(rt.jar,纳入 JDK 类)、`--decompile <fqcn>`、`--log-level`。

**反编译(两种都可):**
```bash
java -jar jar-analyzer-engine.jar --jar app.jar --decompile com.example.MyClass   # 引擎自带 FernFlower
# 或单独打包 CFR.jar(MIT):java -jar cfr.jar <Class.class>
```

> 许可:jar-analyzer-engine = MIT,CFR = MIT,FernFlower = Apache-2.0 —— **均可商用/打包**。
> 避免:完整版 jar-analyzer = GPLv3(传染);GitNexus = PolyForm 非商业。

---

## 4. 数据库 schema(Part 1 ↔ Part 2 的契约,共 14 表)

> 约定:**所有类名是 JVM 内部格式 `/` 分隔**(`com/example/Foo`,不是 `.`)。
> 方法描述符是 JVM 格式(`(Ljava/lang/String;I)V` = `void m(String,int)`)。
> access 是位掩码:`1`=public `2`=private `4`=protected `8`=static `16`=final `512`=interface `1024`=abstract。
> `--quick` 模式下 `method_impl_table / string_table / spring_* / java_web_table` 为空。

| 表 | 关键列 | 用途 |
|---|---|---|
| `jar_table` | jid, jar_name, jar_abs_path | JAR 元信息 |
| `class_table` | cid, jar_id, class_name, super_class_name, is_interface, access, version | 类 |
| `class_file_table` | cf_id, class_name, path_str, jar_name | 类→JAR 内路径 |
| `member_table` | mid, member_name, type_class_name, modifiers, value, class_name | 字段 |
| `method_table` | method_id, method_name, method_desc, is_static, access, line_number, class_name | 方法 |
| `anno_table` | anno_id, anno_name, method_name(NULL=类级), class_name, visible | 注解 |
| `interface_table` | iid, interface_name, class_name | 接口实现 |
| **`method_call_table`** | mc_id, caller_class_name, caller_method_name, caller_method_desc, callee_class_name, callee_method_name, callee_method_desc, op_code | **调用关系(核心,邻接表)** |
| `method_impl_table` | impl_id, class_name(父), method_name, method_desc, impl_class_name(子) | override/实现(多态) |
| `string_table` | sid, value, class_name, method_name, method_desc | 字符串常量(LDC) |
| `spring_controller_table` | sc_id, class_name | Spring 控制器 |
| `spring_method_table` | sm_id, class_name, method_name, method_desc, restful_type, path | Spring 路由 |
| `spring_interceptor_table` | si_id, class_name | Spring 拦截器 |
| `java_web_table` | jw_id, type_name(Servlet/Filter/Listener/Interceptor), class_name | JavaWeb 组件 |

`op_code`:182=invokevirtual 183=invokespecial 184=invokestatic 185=invokeinterface 186=invokedynamic(lambda/方法引用)。

**常用 join:**
- 类→方法:`class_table.class_name = method_table.class_name`
- 方法→调用者:按 `method_call_table.callee_*`
- 方法→被调:按 `method_call_table.caller_*`
- 方法→字符串:`string_table.{class_name,method_name,method_desc}`
- override 链:`method_impl_table.{class_name,method_name,method_desc}`
- 控制器→路由:`spring_controller_table.class_name = spring_method_table.class_name`

---

## 5. Part 2 —— agent 查询工具(只读 SQL 包装)

每个工具 = 一段参数化 SQL。下表给出语义 + 背后 SQL。

| 工具 | 入参 | 背后 |
|---|---|---|
| `analyze_jar` | `{path, quick?, force?}` | **跑 Part 1 生成器**(spawn java);按 sha256+mtime 缓存;设为本 session 活动目标;返回计数摘要 |
| `jar_callers` | `{class, method?, descriptor?, depth?}` | 查 `method_call_table` callee=目标 → caller |
| `jar_callees` | `{class, method?, descriptor?, depth?}` | 同上反向 |
| `jar_find_chains` | `{to:{class,method}, from?, maxDepth?, limit?}` | 递归 CTE(见下),反向从 sink 走;可经 `method_impl_table` 跨多态;`from` 可填具体源或 spring/web 入口 |
| `jar_impact` | `{class, method, maxDepth?}` | 递归 CTE 统计可达调用者(爆炸半径) |
| `jar_find_strings` | `{pattern}` | `string_table WHERE value LIKE` |
| `jar_list_routes` | `{filter?}` | `spring_method_table` ∪ `java_web_table` |
| `jar_search` | `{query, kind?}` | `class_table/method_table` 名字 LIKE(可选建 FTS) |
| `jar_decompile` | `{class}` | 引擎 `--decompile` 或 CFR(spawn java) |

**名称归一**:入参 `class` 接受 `.` 或 `/`,统一转 `/`;给 `method` 不给 `descriptor` 且有重载 → 返回候选 descriptor 让模型重试。
**活动目标**:服务按 `sessionId` 记最近的 `.db` 路径,工具默认用它,可显式传 `target` 覆盖。

**示例 SQL(可直接用):**
```sql
-- 谁调用 Runtime.exec(sink 是 JDK 方法,直接 WHERE,无需外部建模)
SELECT caller_class_name, caller_method_name, caller_method_desc
FROM method_call_table
WHERE callee_class_name='java/lang/Runtime' AND callee_method_name='exec';

-- 所有 Serializable 类(反序列化面)
SELECT class_name FROM interface_table WHERE interface_name='java/io/Serializable';

-- 硬编码敏感串
SELECT class_name, method_name, value FROM string_table
WHERE value LIKE '%password%' OR value LIKE '%jdbc:%' OR value LIKE '%secret%';

-- Web 入口
SELECT 'Spring' src, path, restful_type, class_name, method_name FROM spring_method_table
UNION ALL SELECT type_name, '', '', class_name, '' FROM java_web_table;

-- 找链:从 sink 反向多级追调用者(jar-analyzer DATABASE.md 同款递归 CTE)
WITH RECURSIVE chain AS (
  SELECT caller_class_name, caller_method_name, caller_method_desc, 1 depth
  FROM method_call_table
  WHERE callee_class_name='java/lang/Runtime' AND callee_method_name='exec'
  UNION ALL
  SELECT mc.caller_class_name, mc.caller_method_name, mc.caller_method_desc, c.depth+1
  FROM method_call_table mc JOIN chain c
    ON mc.callee_class_name=c.caller_class_name
   AND mc.callee_method_name=c.caller_method_name
   AND mc.callee_method_desc=c.caller_method_desc
  WHERE c.depth < 8
)
SELECT DISTINCT caller_class_name, caller_method_name, depth FROM chain ORDER BY depth;
```

> 多态:声明类型上的调用要跳到具体实现时,在 CTE 的 JOIN 里额外 union `method_impl_table`
> (父 `{class_name,method_name,method_desc}` → 子 `impl_class_name` 的同名方法),即可从接口/抽象方法走到实现里的 sink。

---

## 6. 集成进 Reina(将来在主仓实现时的对接点)

> 以下是把 Part 2 接进 Reina agent 的具体钩子(实现时参考,不属于"新文件夹"的独立项目)。

- **node:sqlite 只读打开**:Reina 已用 `node:sqlite`(`DatabaseSync`),参照 `packages/core/src/store/session-store.ts`。
- **库路径**:`<workspace>/.reina/java-graph/<sha256(target)>.db`(`reinaConfigHome()` 见 `packages/tools/src/mcp-config.ts`)。
- **工具注册**:`toolNames` 加名(`packages/protocol/src/index.ts`)+ `toolImplementations[]` 注册并设 deferred(`packages/tools/src/registry.ts`)。服务作模块单例(范式见 `packages/tools/src/mcp-runtime.ts`)。
- **spawn java**:用 `execa`(带 `cancelSignal`/timeout,见 `packages/tools/src/tools/execution/shell.ts`);进程清理用 `killProcessTree`(`packages/tools/src/mcp-client.ts`,Windows `taskkill /T /F`)。
- **生命周期**:`packages/agent-host/src/index.ts` 的 `close()` 里关 DB handle / 杀残留 java。
- **打包(开箱即用)**:`vendor/`(精简 JRE + `jar-analyzer-engine.jar` + 可选 `cfr.jar`)进根 `package.json` 的 `files`/`asarUnpack`(node-pty 同款);运行时路径用 `process.resourcesPath`(打包)/ 仓库根(开发)。
- **缓存**:把 target 的 sha256+mtime+引擎版本记进 `.db` 旁的 sidecar 或库内一张小表;`analyze_jar` 命中则跳过重建。

---

## 7. 实现顺序建议(新文件夹里)

1. **生库**:`mvn package` 出 engine.jar;对一个**小样例 jar**(含一个 `Runtime.exec` 调用)跑 `--jar`,得到 `jar-analyzer.db`;用任意 sqlite 客户端确认 `method_call_table` 里有那条 callee=Runtime.exec 的记录。← 先打通这步。
2. **查询层**:Node + `node:sqlite` 写上面那些 SQL 的薄封装(先 callers/callees/find_chains/find_strings)。
3. **包装成工具**:CLI 或直接做成 Reina 内置工具。
4. **analyze_jar**:封装 spawn java 生库 + 缓存。
5. **decompile**:engine `--decompile` 或 CFR。
6. **(可选,后期)** 打包 JRE+jar 开箱即用;加 tabby 做深度污点;加源码图。

---

## 8. 关键决策记录(为什么是现在这样)

- **不重写提取器**:jar-analyzer-engine(MIT)已用成熟 ASM 产出我们要的图,重写 ASM/反编译器是巨大且无收益的工作。
- **不用 CodeGraph/GitNexus**:它们的"图查询"层本质是两张表 + ~几百行 BFS,我们要时自己几条 SQL 就够;它们最值钱的源码解析/resolution 对字节码用不上;且 GitNexus 是非商业 license。
- **关系型直存**:沿用 jar-analyzer 的 14 表,JDK/外部 sink 天然是字符串行,免去属性图的外部节点建模。
- **两段解耦**:生库(重、需 Java、偶尔跑)与查询(轻、纯 node:sqlite、高频)分离。

---

## 9. 参考(本仓 `参考/` 下的只读材料)

- `参考/jar-analyzer-engine/`(MIT 引擎,**主参考**;`DATABASE.md` = schema 权威来源)
- `参考/jar-analyzer/`(完整版,GPLv3;`doc/README-api.md` 有 DFS/反编译等 HTTP 接口可借鉴语义;`skills/jar-audit-agent` 是现成审计方法论)
- `参考/gadget-chain-hunting.md`(反序列化找链方法论,可做成 agent skill)
- `参考/codegraph/`(MIT;图查询实现参考,但本方案不直接用)
- `参考/tabby/`(Soot 调用图 + 污点,后期深度分析可选)
