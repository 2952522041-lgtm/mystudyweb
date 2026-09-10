# 局域网共享数据保护验收记录

记录日期：2026-09-10

## 备份核验

本轮实施前，任务没有提供真实课程工作区的备份证明；本轮也没有执行备份操作。因此这里明确记录为：**备份未提供/未执行**。不能据此声称真实课程数据已有备份。

本轮代码和测试没有读取、写入或删除真实课程目录。只读接口测试使用 `os.tmpdir()` 下的临时工作区，测试结束后清理。

## 临时课程目录清单与哈希比对

自动化测试 `read-only sharing leaves the temporary course workspace unchanged` 会在临时课程工作区内访问课程列表、课程详情、PDF 和 PDF 总结，然后对工作区内全部普通文件做 SHA-256 快照并比较访问前后结果。

测试范围包含以下临时文件清单：

```text
Courses/中文 课程/course.json
Courses/中文 课程/Knowledge/knowledge-v1.json
Courses/中文 课程/课程脑图.json
Courses/中文 课程/Documents/doc-中文-1/document.json
Courses/中文 课程/PDFs/第一 讲义.pdf
```

验证命令：

```bash
cd /home/yusicheng/project/learning_app/demo
pnpm test
```

比对规则等价于：

```text
SHA256(访问前每个文件) == SHA256(访问后同名文件)
访问前后的相对文件清单完全相同
```

本次验收结果：该测试通过；临时工作区文件清单和 SHA-256 均未发生变化。该结果只证明本次只读请求对临时夹具没有写入，不代表真实用户课程目录已经备份。
