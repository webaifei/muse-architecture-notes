1. what is a systemd-nspawn runtime container?
    how to implement this:  Root inside the runtime cell is mapped to an unprivileged host user so runtime cell root is not host root.
2. hatch-safety 运行一套独立的模型和分类器，检查进出核心模型推理的请求和响应
    具体做什么？是说有一个独立的llm检测输入和输出吗？如何实现的？给出代码实现
3. privsep
    是一个进程吗？和其他的服务如何通信？后续给出了答案是Unix domain socket 
    权限被严格收窄 具体是指啥？功能表现是啥？怎么实现？
    看起来privsep是负责connector的代码存储和逻辑执行 而hatch-authd是负责credential auth的存储和 凭据代理化（credential surrogation）
4. hatch-authd
    - credientiaal storage: your vm, not centeralized mete infra
    - credential surrogation
5. Sentinel
    - 看起来是负责链接privsep 和 hatch-authd的？
    - 为啥被叫做separate host-side agent， 这个agent是指他自己也有llm调用的逻辑和能力妈
    - 逻辑
        - loop中需要take action via a connector，
        -  submits a request to Sentinel 
            - via Unix domain socket？
        - Sentinel generates a user-visible purpose for the request
        - Sentinel valuates the connector policy set by the user
        - action should be allowed, denied, or to ask the user
        - approved？
            - and the following steps?
6. 