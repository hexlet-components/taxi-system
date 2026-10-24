import com.rabbitmq.client.ConnectionFactory;

import java.nio.charset.StandardCharsets;
import java.util.List;

public class OfferWorkers {
    public static void main(String[] args) throws Exception {
        var factory = new ConnectionFactory();
        factory.setHost(System.getenv().getOrDefault("RABBITMQ_HOST", "localhost"));
        factory.setUsername("lesson");
        factory.setPassword("lesson");

        for (String worker : List.of("A", "B")) {
            try (var connection = factory.newConnection();
                    var channel = connection.createChannel()) {
                // false отключает автоматическое подтверждение получения
                var delivery = channel.basicGet("lesson-driver-offers", false);
                if (delivery == null) {
                    System.out.println(worker + ": empty");
                    continue;
                }

                String job = new String(delivery.getBody(), StandardCharsets.UTF_8);
                System.out.println(worker + ": " + job);

                // Подтверждаем сообщение после выполнения действия
                channel.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
            }
        }
    }
}
