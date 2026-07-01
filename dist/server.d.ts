declare module 'express-session' {
    interface SessionData {
        user?: {
            id: string;
            username: string;
            globalName: string;
            avatar: string;
            isAdmin: boolean;
        };
    }
}
export {};
//# sourceMappingURL=server.d.ts.map