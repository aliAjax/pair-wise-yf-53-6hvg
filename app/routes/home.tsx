import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, NumberInput, Progress, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  changeUpstream,
  confirmGate,
  createTrain,
  createWindow,
  freezeTrain,
  leaveWindow,
  recordReceipts,
  reorderGates,
  resolveBlocker,
  rollbackTrain,
  useGetTrainHealthQuery,
  useRegisterReposMutation,
  type ReleaseTrain,
  type RepositoryGate,
  type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

function SortableGate({ gate, onConfirm }: { gate: RepositoryGate; onConfirm: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <Title order={3} mb="md">{children}</Title>;
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const [registerRepos, { isLoading: registering }] = useRegisterReposMutation();
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const [windowName, setWindowName] = useState('');
  const [windowCapacity, setWindowCapacity] = useState<number>(2);
  const [targetWindow, setTargetWindow] = useState<string | null>(null);
  const [upstreamPkg, setUpstreamPkg] = useState('shared-ui');
  const [upstreamVersion, setUpstreamVersion] = useState('4.3.0');

  if (!train) return null;

  const unresolved = train.blockers.filter((item) => !item.resolved).length;
  const confirmed = train.gates.filter((item) => item.status === 'confirmed').length;
  const activeWindowId = targetWindow ?? state.windows[0]?.id ?? null;
  const activeWindow = state.windows.find((item) => item.id === activeWindowId);
  const trainWindow = train.windowId ? state.windows.find((item) => item.id === train.windowId) : undefined;

  const windowOptions = state.windows.map((item) => ({ value: item.id, label: `${item.name}（容量 ${item.capacity}）` }));
  const trainName = (id: string) => state.trains.find((item) => item.id === id)?.name ?? id;
  const receiptOf = (windowId: string, repo: string) => state.receipts.find((item) => item.windowId === windowId && item.repo === repo);

  const reconciliation = state.windows.flatMap((win) =>
    state.trains
      .filter((item) => item.windowId === win.id && item.status === 'frozen')
      .flatMap((item) =>
        item.gates.map((gate) => {
          const receipt = receiptOf(win.id, gate.repository);
          return { key: `${win.id}-${gate.repository}`, window: win.name, repo: gate.repository, train: item.name, receiptId: receipt?.id ?? null };
        })
      )
  );

  async function handleRegister(current: ReleaseTrain) {
    if (!current.windowId) return;
    const existing = new Set(state.receipts.filter((item) => item.windowId === current.windowId).map((item) => item.repo));
    const missing = current.gates.map((gate) => gate.repository).filter((repo) => !existing.has(repo));
    if (!missing.length) return;
    const result = await registerRepos({ windowId: current.windowId, trainId: current.id, repos: missing }).unwrap();
    dispatch(recordReceipts({ windowId: current.windowId, trainId: current.id, registered: result.registered, failed: result.failed }));
  }

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>发布窗口容量有限，仓库进窗口要排队；同窗口仓库不得重复占用，远端登记按回执对账。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'queued' ? 'cyan' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} onConfirm={() => dispatch(confirmGate(gate.id))} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <SectionTitle>阻断问题</SectionTitle>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>

          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>发布窗口</Title>
              <Group>
                <TextInput size="xs" placeholder="窗口名称" value={windowName} onChange={(event) => setWindowName(event.currentTarget.value)} />
                <NumberInput size="xs" placeholder="容量" value={windowCapacity} onChange={(value) => setWindowCapacity(Number(value) || 1)} min={1} style={{ width: 90 }} />
                <Button size="xs" variant="light" onClick={() => { if (windowName.trim()) { dispatch(createWindow({ name: windowName.trim(), capacity: windowCapacity })); setWindowName(''); } }}>新建窗口</Button>
              </Group>
            </Group>
            <Stack>
              {state.windows.map((win) => {
                const frozen = state.trains.filter((item) => item.windowId === win.id && item.status === 'frozen');
                return (
                  <Card key={win.id} withBorder>
                    <Group justify="space-between">
                      <Group><Text fw={700}>{win.name}</Text><Badge color={frozen.length >= win.capacity ? 'red' : 'blue'}>名额 {frozen.length}/{win.capacity}</Badge></Group>
                    </Group>
                    <Text size="sm" mt="xs">冻结中：{frozen.length ? frozen.map((item) => item.name).join('、') : '无'}</Text>
                    <Text size="sm" mt="xs">排队：{win.queue.length ? win.queue.map(trainName).join('、') : '无'}</Text>
                  </Card>
                );
              })}
              {!state.windows.length && <Text size="sm" c="dimmed">暂无发布窗口，请先新建。</Text>}
            </Stack>
          </Card>

          <Card withBorder>
            <SectionTitle>占用与回执对账单</SectionTitle>
            <Table striped highlightOnHover>
              <thead><tr><th>窗口</th><th>仓库</th><th>占用列车</th><th>回执编号</th><th>状态</th></tr></thead>
              <tbody>
                {reconciliation.map((row) => (
                  <tr key={row.key}>
                    <td>{row.window}</td><td>{row.repo}</td><td>{row.train}</td>
                    <td>{row.receiptId ?? '—'}</td>
                    <td><Badge color={row.receiptId ? 'green' : 'red'}>{row.receiptId ? '已登记' : '缺回执'}</Badge></td>
                  </tr>
                ))}
                {!reconciliation.length && <tr><td colSpan={5}><Text size="sm" c="dimmed">暂无冻结占用记录。</Text></td></tr>}
              </tbody>
            </Table>
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <SectionTitle>窗口冻结与占位</SectionTitle>
            <Text size="sm" c="dimmed" mb="md">容量内直接冻结占住仓库，容量外排队；同窗口仓库已被其他列车占用时拒绝冻结，先写入生效。</Text>
            <Select data={windowOptions} value={activeWindowId} onChange={setTargetWindow} placeholder="选择发布窗口" mb="sm" />
            <Group>
              <Button onClick={() => { if (activeWindowId) dispatch(freezeTrain({ trainId: train.id, windowId: activeWindowId })); }} disabled={!activeWindowId}>冻结入窗</Button>
              <Button color="red" variant="light" onClick={() => dispatch(rollbackTrain(train.id))} disabled={train.status !== 'frozen'}>回滚并放出占位</Button>
              <Button variant="default" onClick={() => dispatch(leaveWindow(train.id))} disabled={!train.windowId}>退出窗口</Button>
            </Group>
            {train.status === 'queued' && trainWindow && <Alert mt="sm" color="cyan">列车正在 {trainWindow.name} 排队，名额空出后自动补位冻结。</Alert>}
            {train.lastConflict && train.lastConflict.length > 0 && (
              <Alert mt="sm" color="red" title="冻结被拒：先写入生效">
                以下仓库已被其他列车占用：{train.lastConflict.join('、')}。请调整仓库或选择其他窗口。
              </Alert>
            )}
          </Card>

          <Card withBorder>
            <SectionTitle>远端登记与回执</SectionTitle>
            {train.status === 'frozen' && trainWindow ? (
              <>
                <Text size="sm" mb="sm">窗口 {trainWindow.name}：只补登没有回执的仓库，已登记的沿用首次回执编号。</Text>
                <Button fullWidth onClick={() => handleRegister(train)} loading={registering} mb="sm">登记未回执仓库</Button>
                <Stack gap="xs">
                  {train.gates.map((gate) => {
                    const receipt = receiptOf(trainWindow.id, gate.repository);
                    return (
                      <Group key={gate.id} justify="space-between">
                        <Text size="sm">{gate.repository}</Text>
                        <Badge size="sm" color={receipt ? 'green' : 'gray'}>{receipt ? receipt.id : '未登记'}</Badge>
                      </Group>
                    );
                  })}
                </Stack>
              </>
            ) : (
              <Text size="sm" c="dimmed">列车冻结入窗后可登记远端回执。</Text>
            )}
          </Card>

          <Card withBorder>
            <SectionTitle>上游版本变更</SectionTitle>
            <Text size="sm" c="dimmed" mb="md">上游版本一变，依赖它的门禁确认立即作废，列车退出窗口放出占位，排队名额自动补上。</Text>
            <Stack>
              <TextInput label="上游包名" value={upstreamPkg} onChange={(event) => setUpstreamPkg(event.currentTarget.value)} />
              <TextInput label="新版本" value={upstreamVersion} onChange={(event) => setUpstreamVersion(event.currentTarget.value)} />
              <Button variant="light" onClick={() => { if (upstreamPkg.trim() && upstreamVersion.trim()) dispatch(changeUpstream({ pkg: upstreamPkg.trim(), version: upstreamVersion.trim() })); }}>发布变更并作废确认</Button>
            </Stack>
          </Card>

          <Card withBorder>
            <SectionTitle>新建发布列车</SectionTitle>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <SectionTitle>审计历史</SectionTitle>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <SectionTitle>其他列车</SectionTitle>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
