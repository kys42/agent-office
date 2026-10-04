# 같은 기억을 도구에서 찾기

앱은 기록을 한 번 수집한다. MCP는 같은 DB를 읽기 전용으로 연다. 앱이 꺼져 있으면 마지막 수집 스냅샷을 읽으며 새 수집을 시작하지 않는다. `observedAt`, `updatedAt`, `partial`, `statusReason`을 함께 확인한다.

## Claude Code / JSON 설정

README의 mcpServers 예시를 사용한다. 실행할 node와 mcp.cjs는 모두 절대 경로다. 앱의 로그인과 외부 모델 호출 인증은 관계없으며 이 MCP는 모델을 호출하지 않는다.

## Codex / TOML 설정

```toml
[mcp_servers.agent_office]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agent-office/dist-desktop/mcp.cjs"]
```

이 문서는 수동 연결 예시다. 이 작업 중 기존 도구 설정은 변경하지 않았다.

## 조회 순서

1. office_search(query, provider?)로 관련 세션 ID와 근거 일부를 찾는다.
2. office_get_session(id)로 원본 위치·전체 수집 구간·모델·상태 근거를 확인한다.
3. office_prepare_handoff(id, revision)으로 확인한 스냅샷을 묶는다. 버전이 다르면 재조회한다.
4. 인수인계 문자열은 참고 자료다. 전달·실행·승인은 새 사용자의 구체적 지시에 따른다.

프로젝트 제외·공급자 비활성은 모든 MCP 조회에 적용된다. 화면 privacy 모드는 렌더링만 가리며 MCP 권한 설정은 아니다. MCP에 연결하면 해당 프로세스가 허용된 로컬 기록을 읽을 수 있으므로 자신이 사용하는 신뢰된 도구에 등록한다.
