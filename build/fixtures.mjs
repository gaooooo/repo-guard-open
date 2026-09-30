/**
 * 回归脚本共用的 fixture 仓库（verify-parity / verify-viz）。
 * 从 verify-parity.mjs 原样搬出，内容不改 —— 改了等于改了 parity 的输入。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURES = {
  web: {
    'package.json': JSON.stringify(
      {
        name: 'parity-web',
        private: true,
        dependencies: { react: '^18.2.0', 'react-router-dom': '^6.20.0', antd: '^5.12.0' },
      },
      null,
      2,
    ),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }, null, 2),

    // ── 公共层：组件 ──
    'src/components/Button/index.tsx':
      "import React from 'react';\n" +
      "export interface ButtonProps { text: string; onClick?: () => void; size?: 'sm' | 'lg' }\n" +
      'export const Button = ({ text, onClick }: ButtonProps) => <button onClick={onClick}>{text}</button>;\n',
    'src/components/DataTable/index.tsx':
      "import React from 'react';\n" +
      "import { Table, Pagination } from 'antd';\n" +
      "import { Button } from '../Button';\n" +
      'export interface DataTableProps { rows: unknown[]; total?: number; loading?: boolean }\n' +
      'export const DataTable = ({ rows, total }: DataTableProps) => (\n' +
      '  <div><Table dataSource={rows} /><Pagination total={total} /><Button text="刷新" /></div>\n' +
      ');\n',
    'src/components/MultiSelect/index.tsx':
      "import React from 'react';\n" +
      'export interface MultiSelectProps { options: string[]; value: string[]; onChange: (v: string[]) => void }\n' +
      'export const MultiSelect = (p: MultiSelectProps) => <select multiple>{p.options.map((o) => <option key={o}>{o}</option>)}</select>;\n',

    // ── 公共层：工具与服务 ──
    'src/utils/format.ts':
      'export function formatDate(d: Date): string { return d.toISOString().slice(0, 10); }\n' +
      'export function formatMoney(n: number): string { return n.toFixed(2); }\n',
    'src/utils/request.ts':
      'export async function request(url: string, opts: Record<string, unknown>) {\n' +
      '  const res = await fetch(url, opts as RequestInit);\n' +
      '  return res.json();\n' +
      '}\n',
    'src/services/user.ts':
      "import { request } from '../utils/request';\n" +
      'export async function fetchUsers(params: { page: number; pageSize: number; keyword?: string }) {\n' +
      "  return request('/api/users', { method: 'GET', params });\n" +
      '}\n' +
      'export async function deleteUser(id: string) {\n' +
      "  return request('/api/users/delete', { method: 'POST', data: { id, force: false } });\n" +
      '}\n',
    'src/services/order.ts':
      "import { request } from '../utils/request';\n" +
      'export async function fetchOrders(params: { page: number; status?: string }) {\n' +
      "  return request('/api/orders', { method: 'GET', params });\n" +
      '}\n',

    // ── 业务页面。JSX 里的 Table / Pagination / Input / Form / Modal 决定 tagPage 打出的
    //    页面指纹标签（list / pagination / search / table / form / modal / detail），
    //    similar 全靠这些标签找同类实现，不放这些组件名就只能拿到空结果。
    'src/views/UserList/index.tsx':
      "import React, { useState } from 'react';\n" +
      "import { Input, Modal } from 'antd';\n" +
      "import { DataTable } from '@/components/DataTable';\n" +
      "import { MultiSelect } from '@/components/MultiSelect';\n" +
      "import { fetchUsers, deleteUser } from '@/services/user';\n" +
      "import { formatDate } from '@/utils/format';\n" +
      'export default function UserList() {\n' +
      '  const [page, setPage] = useState(1);\n' +
      "  const [keyword, setKeyword] = useState('');\n" +
      '  const load = () => fetchUsers({ page, pageSize: 20, keyword });\n' +
      "  const remove = (id: string) => deleteUser(id);\n" +
      '  return (\n' +
      '    <div>\n' +
      '      <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />\n' +
      '      <MultiSelect options={[]} value={[]} onChange={() => {}} />\n' +
      '      <DataTable rows={[]} total={0} />\n' +
      '      <Modal open={false} onOk={() => remove("1")} />\n' +
      '      {formatDate(new Date())}\n' +
      '    </div>\n' +
      '  );\n' +
      '}\n',
    'src/views/OrderList/index.tsx':
      "import React, { useState } from 'react';\n" +
      "import { Input } from 'antd';\n" +
      "import { DataTable } from '@/components/DataTable';\n" +
      "import { fetchOrders } from '@/services/order';\n" +
      "import { formatMoney } from '@/utils/format';\n" +
      'export default function OrderList() {\n' +
      '  const [page] = useState(1);\n' +
      "  const [keyword, setKeyword] = useState('');\n" +
      '  const load = () => fetchOrders({ page, status: keyword });\n' +
      '  return <div><Input value={keyword} /><DataTable rows={[]} total={0} />{formatMoney(page)}</div>;\n' +
      '}\n',
    'src/views/UserDetail/index.tsx':
      "import React from 'react';\n" +
      "import { Form } from 'antd';\n" +
      "import { Button } from '@/components/Button';\n" +
      "import { formatDate } from '@/utils/format';\n" +
      'export default function UserDetail() {\n' +
      '  return <Form><Button text="返回" />{formatDate(new Date())}</Form>;\n' +
      '}\n',

    // ── 路由表。必须是变量声明的**直接**数组字面量：分析器在 VariableDeclarator
    //    的 init 上扫 { path, component/element }，包在 createBrowserRouter(...) 调用里
    //    就扫不到（unwrapExpr 只剥 as / 括号，不剥 CallExpression 的实参）。
    'src/router/routes.tsx':
      "import UserList from '../views/UserList';\n" +
      "import OrderList from '../views/OrderList';\n" +
      "import UserDetail from '../views/UserDetail';\n" +
      'export const routes = [\n' +
      "  { path: '/users', component: UserList },\n" +
      "  { path: '/orders', component: OrderList },\n" +
      "  { path: '/users/detail', component: UserDetail },\n" +
      '];\n',

    // ── 超长文件：喂 scan 的行数上限判定 ──
    'src/components/Legacy/huge.tsx': 'export const X = 1;\n'.repeat(620),
    // ── 同名前缀目录：喂路径归一的不误伤判定 ──
    'src/components-legacy/old.tsx': 'export const Old = 1;\n',
    // ── 循环依赖：喂 scan 的 cycles 判定 ──
    'src/utils/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
    'src/utils/b.ts': "import { a } from './a';\nexport const b = () => a();\n",
  },

  go: {
    'go.mod': 'module parity/api\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
    'cmd/server/main.go':
      'package main\n\n' +
      'import (\n\t"parity/api/internal/router"\n\t"github.com/gin-gonic/gin"\n)\n\n' +
      'func main() {\n\tr := gin.Default()\n\trouter.Register(r)\n\t_ = r.Run(":8080")\n}\n',
    'internal/router/router.go':
      'package router\n\n' +
      'import (\n\t"parity/api/internal/handler"\n\t"github.com/gin-gonic/gin"\n)\n\n' +
      'func Register(r *gin.Engine) {\n' +
      '\tg := r.Group("/api")\n' +
      '\tg.GET("/users", handler.ListUsers)\n' +
      '\tg.POST("/users/delete", handler.DeleteUser)\n' +
      '\tg.GET("/orders", handler.ListOrders)\n' +
      '}\n',
    'internal/handler/user.go':
      'package handler\n\n' +
      'import (\n\t"parity/api/internal/service"\n\t"github.com/gin-gonic/gin"\n)\n\n' +
      'func ListUsers(c *gin.Context) {\n\tc.JSON(200, service.QueryUsers(c.Query("keyword")))\n}\n\n' +
      'func DeleteUser(c *gin.Context) {\n\tservice.RemoveUser(c.PostForm("id"))\n\tc.JSON(200, nil)\n}\n',
    'internal/handler/order.go':
      'package handler\n\n' +
      'import (\n\t"parity/api/internal/service"\n\t"github.com/gin-gonic/gin"\n)\n\n' +
      'func ListOrders(c *gin.Context) {\n\tc.JSON(200, service.QueryOrders())\n}\n',
    'internal/service/user.go':
      'package service\n\n' +
      'import "parity/api/internal/common"\n\n' +
      'func QueryUsers(kw string) []string {\n\treturn common.Paginate([]string{kw})\n}\n\n' +
      'func RemoveUser(id string) {\n\tcommon.AuditLog("remove", id)\n}\n',
    'internal/service/order.go':
      'package service\n\n' +
      'import "parity/api/internal/common"\n\n' +
      'func QueryOrders() []string {\n\treturn common.Paginate(nil)\n}\n',
    'internal/common/util.go':
      'package common\n\n' +
      'func Paginate(in []string) []string {\n\treturn in\n}\n\n' +
      'func AuditLog(action, target string) {}\n',
  },

  // ── 下面三个 fixture 只为**证明分析器真能建图** ──
  //
  // 它们比 web / go 简单得多，因为目的不同：web / go 要驱动 impact / trace /
  // similar 的完整渲染，这三个只要回答「换成这个技术栈，init 认得出来吗、
  // 建出来的图有东西吗」。
  //
  // 为什么这件事必须验：这三个分析器（java-spring / python-ast / node-babel）
  // 是逐字移植过来的，从来没在这个插件里跑过一次真实建图。而**空图是最坏的
  // 失败模式** —— 模型会把"没有调用者"当成事实去删代码，而且没有任何报错。

  java: {
    'pom.xml':
      '<project><modelVersion>4.0.0</modelVersion>\n' +
      '<groupId>parity</groupId><artifactId>api</artifactId><version>1.0</version>\n' +
      '<dependencies><dependency><groupId>org.springframework.boot</groupId>' +
      '<artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n',
    'src/main/java/com/parity/controller/UserController.java':
      'package com.parity.controller;\n\n' +
      'import org.springframework.web.bind.annotation.*;\n' +
      'import com.parity.service.UserService;\n\n' +
      '@RestController\n@RequestMapping("/api/users")\npublic class UserController {\n' +
      '  private final UserService userService;\n' +
      '  public UserController(UserService s) { this.userService = s; }\n' +
      '  @GetMapping("/list")\n  public Object list(@RequestParam String keyword) {\n' +
      '    return userService.query(keyword);\n  }\n' +
      '  @PostMapping("/delete")\n  public void delete(@RequestParam String id) {\n' +
      '    userService.remove(id);\n  }\n}\n',
    'src/main/java/com/parity/service/UserService.java':
      'package com.parity.service;\n\n' +
      'import org.springframework.stereotype.Service;\n' +
      'import com.parity.common.Pager;\n\n' +
      '@Service\npublic class UserService {\n' +
      '  public Object query(String kw) { return Pager.paginate(kw); }\n' +
      '  public void remove(String id) { Pager.audit(id); }\n}\n',
    'src/main/java/com/parity/common/Pager.java':
      'package com.parity.common;\n\n' +
      'public class Pager {\n' +
      '  public static Object paginate(String kw) { return kw; }\n' +
      '  public static void audit(String id) {}\n}\n',
  },

  python: {
    'pyproject.toml': '[project]\nname = "parity-api"\nversion = "0.1.0"\ndependencies = ["fastapi"]\n',
    'app/main.py':
      'from fastapi import FastAPI\n'
      + 'from app.routes import router\n\n'
      + 'app = FastAPI()\n'
      + 'app.include_router(router)\n',
    'app/routes.py':
      'from fastapi import APIRouter\n'
      + 'from app.service import query_users, remove_user\n\n'
      + 'router = APIRouter()\n\n\n'
      + "@router.get('/api/users')\n"
      + 'def list_users(keyword: str = ""):\n'
      + '    return query_users(keyword)\n\n\n'
      + "@router.post('/api/users/delete')\n"
      + 'def delete_user(uid: str):\n'
      + '    remove_user(uid)\n'
      + '    return {}\n',
    'app/service.py':
      'from app.common import paginate, audit_log\n\n\n'
      + 'def query_users(kw):\n'
      + '    return paginate([kw])\n\n\n'
      + 'def remove_user(uid):\n'
      + "    audit_log('remove', uid)\n",
    'app/common.py':
      'def paginate(items):\n'
      + '    return items\n\n\n'
      + 'def audit_log(action, target):\n'
      + '    return None\n',
  },

  // node-babel：纯后端 Node（koa），没有 JSX、没有 react 依赖。
  // 这样 web-frontend 分析器打低分、node-babel 打高分，能验证
  // registry 的「按置信度择优」在真实输入上工作。
  //
  // ⚠️ 路由必须写成 `router.get('/x', ctrl.method)` —— handler 得是**成员表达式**。
  // node-babel 的判据是「对象名叫 router/api/app/mux + handler 是 obj.prop」，
  // 裸标识符（`router.get('/x', listUsers)`）认不出来，会得到 0 个入口。
  // 第一版 fixture 就是那么写的，结果验出来是空入口 —— 那种图谱最危险：
  // 「受影响入口 0」会被模型读成"可以安全删"。
  node: {
    'package.json': JSON.stringify(
      { name: 'parity-node', private: true, dependencies: { koa: '^2.15.0', '@koa/router': '^12.0.0' } },
      null,
      2,
    ),
    'src/app.js':
      "const Koa = require('koa');\n" +
      "const router = require('./router');\n" +
      'const app = new Koa();\n' +
      'app.use(router.routes());\n' +
      'module.exports = app;\n',
    'src/router.js':
      "const Router = require('@koa/router');\n" +
      "const ctrl = require('./service/user');\n" +
      'const router = new Router();\n' +
      "router.get('/api/users', ctrl.listUsers);\n" +
      "router.post('/api/users/delete', ctrl.removeUser);\n" +
      'module.exports = router;\n',
    'src/service/user.js':
      "const { paginate, auditLog } = require('../common/util');\n" +
      'async function listUsers(ctx) {\n' +
      '  ctx.body = paginate([ctx.query.keyword]);\n' +
      '}\n' +
      'async function removeUser(ctx) {\n' +
      "  auditLog('remove', ctx.request.body.id);\n" +
      '  ctx.body = {};\n' +
      '}\n' +
      'module.exports = { listUsers, removeUser };\n',
    'src/common/util.js':
      'function paginate(items) {\n  return items;\n}\n' +
      'function auditLog(action, target) {}\n' +
      'module.exports = { paginate, auditLog };\n',
  },
};

/** 人写的红线意图 —— 喂 audit 的三类腐烂判定（守空气 / 后门 / 证据失准） */
export const REDLINES = {
  rules: [
    {
      id: 'RL-001',
      paths: ['src/services/**'],
      rule: '这个接口有外部调用方，改名等于让对方 404',
      protects: ['fetchUsers'],
      evidence: 'src/services/user.ts:2',
      confirmed: true,
    },
    {
      id: 'RL-002',
      paths: ['src/utils/format.ts'],
      rule: '这个格式化函数被多处依赖，不能改签名',
      protects: ['formatDate'],
      confirmed: true,
    },
    {
      id: 'RL-003',
      paths: ['src/nowhere/**'],
      rule: '这条规则在守空气，audit 应当报出来',
      protects: ['thisSymbolDoesNotExistAnywhere'],
      confirmed: true,
    },
  ],
};

export function materialize(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  // 图谱新鲜度判据之一是 git HEAD，没有 commit 会走"无 HEAD"分支，覆盖不到主路径。
  // 固定 author/committer 时间，让两侧的 commit sha 完全一致。
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'parity',
    GIT_AUTHOR_EMAIL: 'parity@local',
    GIT_COMMITTER_NAME: 'parity',
    GIT_COMMITTER_EMAIL: 'parity@local',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir, env });
  spawnSync('git', ['add', '-A'], { cwd: dir, env });
  spawnSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: dir, env });
}
