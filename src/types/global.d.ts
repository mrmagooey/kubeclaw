declare module 'irc-upd' {
  const IRC: {
    Client: new (
      server: string,
      nick: string,
      options?: Record<string, unknown>,
    ) => unknown;
  };
  export default IRC;
}
