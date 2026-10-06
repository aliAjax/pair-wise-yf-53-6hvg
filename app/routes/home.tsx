import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  changeGateVersion,
  confirmGate,
  createTrain,
  exitWindow,
  registerRemote,
  reorderGates,
  requestSlot,
  resolveBlocker,
  setFreeze,
  submitFreeze,
  useGetTrainHealthQuery,
  type ReleaseWindow,
  type RepositoryGate,
  type RootState
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

function bumpPatch(version: string) {
  const parts = version.split('.');
  const last = Number(parts[parts.length - 1]);
  if (Number.isNaN(last)) return `${version}.1`;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}

function SortableGate({ gate, onConfirm, onBump }: { gate: RepositoryGate; onConfirm: () => void; onBump: () => void }) {
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
          <Button size="xs" variant="light" color="violet" onClick={onBump}>升版本</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;

  function trainName(id: string) {
    return state.trains.find((item) => item.id === id)?.name ?? id;
  }
  function receiptOf(window: ReleaseWindow, repo: string) {
    return state.receipts.find((item) => item.key === `${window.id}:${repo}`);
  }
  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  if (!train) return null;
  const ledgerRows = state.windows.flatMap((window) => [
    ...window.slots.map((slot) => ({ window, slot, kind: '占用中' as const })),
    ...window.queue.map((slot, index) => ({ window, slot, kind: `排队 #${index + 1}` }))
  ]);

  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。窗口名额有限，占位、回执与冻结先写入者优先。</Text></div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
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
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序 · 升版本会作废下游确认</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => (
                  <SortableGate
                    key={gate.id}
                    gate={gate}
                    onConfirm={() => dispatch(confirmGate(gate.id))}
                    onBump={() => dispatch(changeGateVersion({ gateId: gate.id, version: bumpPatch(gate.version) }))}
                  />
                ))}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>发布窗口</Title><Text size="sm" c="dimmed">容量有限 · 满员排队 · 冻结先写入生效</Text></Group>
            <Stack>
              {state.windows.map((window) => (
                <Card key={window.id} withBorder radius="md">
                  <Group justify="space-between" mb="xs">
                    <Group>
                      <Text fw={700}>{window.name}</Text>
                      <Badge color={window.frozenBy ? 'blue' : 'gray'}>{window.frozenBy ? `已冻结 · ${trainName(window.frozenBy)}` : '开放中'}</Badge>
                    </Group>
                    <Text size="sm" c="dimmed">名额 {window.slots.length}/{window.capacity} · 排队 {window.queue.length}</Text>
                  </Group>
                  <Progress mb="sm" value={(window.slots.length / window.capacity) * 100} color={window.slots.length >= window.capacity ? 'red' : 'teal'} />
                  <Stack gap={4} mb="sm">
                    {window.slots.map((slot) => {
                      const receipt = receiptOf(window, slot.repo);
                      return (
                        <Group key={`${slot.trainId}-${slot.repo}`} justify="space-between">
                          <Text size="sm">{slot.repo} · {trainName(slot.trainId)}</Text>
                          <Badge variant="light" color={receipt ? 'green' : 'orange'}>{receipt ? `回执 ${receipt.number}` : '待补登'}</Badge>
                        </Group>
                      );
                    })}
                    {window.queue.map((entry, index) => (
                      <Group key={`q-${entry.trainId}-${entry.repo}`} justify="space-between">
                        <Text size="sm" c="dimmed">{entry.repo} · {trainName(entry.trainId)}</Text>
                        <Badge variant="outline" color="gray">排队 #{index + 1}</Badge>
                      </Group>
                    ))}
                  </Stack>
                  <Group>
                    <Button size="xs" onClick={() => train.gates.forEach((gate) => dispatch(requestSlot({ windowId: window.id, gateId: gate.id })))}>当前列车进窗口</Button>
                    <Button size="xs" color="blue" variant="light" onClick={() => dispatch(submitFreeze({ windowId: window.id }))}>提交冻结</Button>
                    <Button size="xs" color="teal" variant="light" onClick={() => dispatch(registerRemote({ windowId: window.id }))}>远端登记/补登</Button>
                    <Button size="xs" color="red" variant="subtle" onClick={() => dispatch(exitWindow({ windowId: window.id }))}>退出窗口</Button>
                  </Group>
                </Card>
              ))}
            </Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">占用与回执对账单</Title>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr><Table.Th>窗口</Table.Th><Table.Th>仓库</Table.Th><Table.Th>占用列车</Table.Th><Table.Th>占位状态</Table.Th><Table.Th>回执编号</Table.Th><Table.Th>时间</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {ledgerRows.map(({ window, slot, kind }) => {
                  const receipt = receiptOf(window, slot.repo);
                  return (
                    <Table.Tr key={`${window.id}-${slot.trainId}-${slot.repo}-${kind}`}>
                      <Table.Td>{window.name}</Table.Td>
                      <Table.Td>{slot.repo}</Table.Td>
                      <Table.Td>{trainName(slot.trainId)}</Table.Td>
                      <Table.Td><Badge color={kind === '占用中' ? 'teal' : 'gray'} variant="light">{kind}</Badge></Table.Td>
                      <Table.Td>{receipt ? receipt.number : '—'}</Table.Td>
                      <Table.Td>{slot.at}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button></Group>)}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">回滚会放出该列车在全部窗口的占位，排队列车自动补位。</Text>
            <Group><Button onClick={() => dispatch(setFreeze('frozen'))}>冻结列车</Button><Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button><Button variant="default" onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
